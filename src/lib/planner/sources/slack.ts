/**
 * Slack planner source (spec §4.5): mentions of the user plus DM / group-DM
 * conversations whose latest message is still waiting on a reply.
 *
 * Resolution is deliberately timid — absence from a lookback-bounded read is
 * not a fact, so only *open* items may be resolved, and nothing at all when the
 * conversation listing was longer than this run read.
 */
import { prisma } from '@/lib/db'
import { conversationHistory, listDmConversations, searchMentions } from '@/lib/slack/client'
import type { SlackMessage } from '@/lib/slack/client'
import type { SourceContext, SourceItem, SourceRead } from '@/lib/planner/types'

const DEFAULT_LOOKBACK_HOURS = 48
const DEFAULT_MAX_DM_CONVERSATIONS = 15
const HISTORY_LIMIT = 20
const HISTORY_CONCURRENCY = 4
const TITLE_TEXT_CHARS = 80
const SUMMARY_CHARS = 500
const PAYLOAD_TEXT_CHARS = 4000

type Conversation = Awaited<ReturnType<typeof listDmConversations>>['conversations'][number]

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** `updated` desc when Slack supplies it, else `priority` desc, else as returned. */
function recencyRank(conversation: Conversation): number {
  if (typeof conversation.updated === 'number') return conversation.updated
  if (typeof conversation.priority === 'number') return conversation.priority
  return Number.NEGATIVE_INFINITY
}

function toItem(message: SlackMessage, kind: 'mention' | 'dm'): SourceItem {
  const text = message.text
  const head = text.slice(0, TITLE_TEXT_CHARS)
  const where = kind === 'mention' && message.channelName ? ` in #${message.channelName}` : ''
  return {
    sourceKey: `slack:${message.channelId}:${message.ts}`,
    title: `${message.userName}${where}: ${head}`,
    summary: text.slice(0, SUMMARY_CHARS),
    url: message.permalink,
    payload: {
      channelId: message.channelId,
      channelName: message.channelName,
      ts: message.ts,
      threadTs: message.threadTs,
      slackUserId: message.userId,
      userName: message.userName,
      text: text.slice(0, PAYLOAD_TEXT_CHARS),
      kind,
    },
  }
}

/** Runs `task` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await task(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export async function readSlack(ctx: SourceContext): Promise<SourceRead | null> {
  const cred = await prisma.slackCredential.findUnique({ where: { userId: ctx.userId } })
  if (!cred) return null

  const lookbackHours = positiveIntEnv('PLANNER_SLACK_LOOKBACK_HOURS', DEFAULT_LOOKBACK_HOURS)
  const maxConversations = positiveIntEnv(
    'PLANNER_SLACK_MAX_DM_CONVERSATIONS',
    DEFAULT_MAX_DM_CONVERSATIONS
  )
  const oldest = new Date(ctx.now.getTime() - lookbackHours * 60 * 60 * 1000)

  const { messages: mentions, truncated: mentionsTruncated } = await searchMentions(ctx.userId, {
    slackUserId: cred.slackUserId,
    oldest,
  })

  const { conversations, truncated } = await listDmConversations(ctx.userId)
  const selected = [...conversations]
    .sort((a, b) => recencyRank(b) - recencyRank(a))
    .slice(0, maxConversations)

  const histories = await mapWithConcurrency(selected, HISTORY_CONCURRENCY, (conversation) =>
    conversationHistory(ctx.userId, conversation.id, { oldest, limit: HISTORY_LIMIT })
  )

  const items: SourceItem[] = []
  const seen = new Set<string>()
  const push = (item: SourceItem): void => {
    if (seen.has(item.sourceKey)) return
    seen.add(item.sourceKey)
    items.push(item)
  }

  for (const mention of mentions) push(toItem(mention, 'mention'))

  for (const history of histories) {
    const latest = [...history].sort((a, b) => Number(b.ts) - Number(a.ts))[0]
    // Only conversations awaiting *our* reply are work.
    if (!latest || latest.userId === cred.slackUserId) continue
    push(toItem(latest, 'dm'))
  }

  // More conversations than this run read (or a truncated listing) means an
  // unread DM could be missing from `items` — claim no resolution authority.
  const complete = !truncated && !mentionsTruncated && conversations.length <= maxConversations
  return { items, resolveMissing: complete ? 'open' : 'none' }
}
