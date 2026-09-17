/**
 * Slack Web API client (spec §4.8). Every helper but `slackApi` / `authTest`
 * takes the *app* user id and resolves the Slack user token through
 * `getSlackAccessToken` (which also touches `lastUsedAt`). Network goes through
 * the shared fetch seam, so this module never imports the OAuth transport.
 */
import { getSlackAccessToken } from './oauth'
import { slackFetch, slackSleep } from './fetch'
import { SlackApiError, SlackHttpError } from './errors'

const API_BASE = 'https://slack.com/api'
const MAX_RETRY_AFTER_MS = 5000
const USER_NAME_TTL_MS = 10 * 60 * 1000
const DM_PAGE_LIMIT = 200
const DEFAULT_SEARCH_COUNT = 20

export interface SlackMessage {
  channelId: string
  channelName: string | null
  ts: string
  threadTs: string | null
  userId: string
  userName: string
  text: string
  permalink: string | null
}

type SlackParams = Record<string, string | number | boolean | undefined>

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function retryAfterMs(res: Awaited<ReturnType<typeof slackFetch>>): number {
  const raw = Number(res.headers?.get('retry-after') ?? '1')
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : 1
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
}

/**
 * One Slack call: GET with a query string for reads, POST JSON for writes.
 * A single 429 is retried after min(Retry-After, 5s); anything else non-2xx is
 * a SlackHttpError, and `ok: false` is a SlackApiError.
 */
export async function slackApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  params: SlackParams,
  opts?: { post?: boolean }
): Promise<T> {
  const defined = Object.entries(params).filter(([, v]) => v !== undefined) as Array<
    [string, string | number | boolean]
  >

  let url = `${API_BASE}/${method}`
  let init: Parameters<typeof slackFetch>[1]

  if (opts?.post) {
    init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(Object.fromEntries(defined)),
    }
  } else {
    const query = new URLSearchParams(defined.map(([k, v]) => [k, String(v)])).toString()
    if (query) url = `${url}?${query}`
    init = { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
  }

  let res = await slackFetch(url, init)
  if (res.status === 429) {
    await slackSleep(retryAfterMs(res))
    res = await slackFetch(url, init)
  }
  if (!res.ok) throw new SlackHttpError(res.status, await res.text())

  const body = asRecord(await res.json())
  if (body.ok !== true) {
    throw new SlackApiError(typeof body.error === 'string' ? body.error : 'unknown_error')
  }
  return body as T
}

export async function authTest(
  token: string
): Promise<{ userId: string; teamId: string; url: string }> {
  const body = await slackApi(token, 'auth.test', {})
  return {
    userId: String(body.user_id ?? ''),
    teamId: String(body.team_id ?? ''),
    url: String(body.url ?? ''),
  }
}

function permalinkFrom(teamUrl: string | null, channelId: string, ts: string): string | null {
  if (!teamUrl) return null
  return `${teamUrl.replace(/\/+$/, '')}/archives/${channelId}/p${ts.replace('.', '')}`
}

// users.info memo, per process, keyed by app user + Slack user (spec §4.8: 10 min).
const userNameCache = new Map<string, { name: string; at: number }>()

/** Test seam: clears the users.info memo. */
export function __resetSlackCachesForTests(): void {
  userNameCache.clear()
}

async function userName(
  token: string,
  cacheKeyPrefix: string,
  slackUserId: string
): Promise<string> {
  if (!slackUserId) return 'unknown'
  const key = `${cacheKeyPrefix}:${slackUserId}`
  const hit = userNameCache.get(key)
  if (hit && Date.now() - hit.at < USER_NAME_TTL_MS) return hit.name

  const body = await slackApi(token, 'users.info', { user: slackUserId })
  const user = asRecord(body.user)
  const profile = asRecord(user.profile)
  const name = str(profile.display_name) ?? str(user.real_name) ?? str(user.name) ?? slackUserId
  userNameCache.set(key, { name, at: Date.now() })
  return name
}

/** users.info, memoised per process for 10 minutes. */
export async function resolveUserName(userId: string, slackUserId: string): Promise<string> {
  const { token } = await getSlackAccessToken(userId)
  return userName(token, userId, slackUserId)
}

function dateMinusOneDay(at: Date): string {
  return new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** Mentions of the user since `oldest`, newest first. */
export interface MentionSearch {
  messages: SlackMessage[]
  /** true when Slack reported more matches than the single page read */
  truncated: boolean
}

export async function searchMentions(
  userId: string,
  args: { slackUserId: string; oldest: Date; limit?: number }
): Promise<MentionSearch> {
  const { token } = await getSlackAccessToken(userId)
  const body = await slackApi(token, 'search.messages', {
    // `after:` is day-granular, so widen by a day and filter on ts below.
    query: `<@${args.slackUserId}> after:${dateMinusOneDay(args.oldest)}`,
    sort: 'timestamp',
    sort_dir: 'desc',
    count: args.limit ?? DEFAULT_SEARCH_COUNT,
  })

  const messages = asRecord(body.messages)
  const matches = messages.matches
  if (!Array.isArray(matches)) return { messages: [], truncated: false }
  const paging = asRecord(messages.paging)
  const pages = typeof paging.pages === 'number' ? paging.pages : 1
  const total = typeof messages.total === 'number' ? messages.total : matches.length
  const truncated = pages > 1 || total > matches.length
  const oldestTs = args.oldest.getTime() / 1000

  const out: SlackMessage[] = []
  for (const raw of matches) {
    const match = asRecord(raw)
    const ts = str(match.ts)
    if (!ts || Number(ts) < oldestTs) continue
    const channel = asRecord(match.channel)
    out.push({
      channelId: str(channel.id) ?? '',
      channelName: str(channel.name),
      ts,
      threadTs: str(match.thread_ts),
      userId: str(match.user) ?? '',
      userName: str(match.username) ?? str(match.user) ?? 'unknown',
      text: typeof match.text === 'string' ? match.text : '',
      permalink: str(match.permalink),
    })
  }
  return { messages: out, truncated }
}

export interface SlackConversation {
  id: string
  isMpim: boolean
  userId?: string
  updated?: number
  priority?: number
}

/**
 * Every DM / group DM the user is in. `conversations.list` has no sort
 * parameter, so the listing is exhaustive (the caller picks) and `truncated`
 * reports that a cursor was still pending at `maxPages`.
 */
export async function listDmConversations(
  userId: string,
  args?: { maxPages?: number }
): Promise<{ conversations: SlackConversation[]; truncated: boolean }> {
  const { token } = await getSlackAccessToken(userId)
  const maxPages = args?.maxPages ?? 5
  const conversations: SlackConversation[] = []
  let cursor: string | undefined

  for (let page = 0; page < maxPages; page++) {
    const body = await slackApi(token, 'conversations.list', {
      types: 'im,mpim',
      exclude_archived: true,
      limit: DM_PAGE_LIMIT,
      cursor,
    })
    const channels = Array.isArray(body.channels) ? body.channels : []
    for (const raw of channels) {
      const channel = asRecord(raw)
      const id = str(channel.id)
      if (!id || channel.is_user_deleted === true) continue
      conversations.push({
        id,
        isMpim: channel.is_mpim === true,
        userId: typeof channel.user === 'string' ? channel.user : undefined,
        updated: typeof channel.updated === 'number' ? channel.updated : undefined,
        priority: typeof channel.priority === 'number' ? channel.priority : undefined,
      })
    }
    cursor = str(asRecord(body.response_metadata).next_cursor) ?? undefined
    if (!cursor) break
  }

  return { conversations, truncated: Boolean(cursor) }
}

/** Messages in one conversation since `oldest`, newest first. */
export async function conversationHistory(
  userId: string,
  channelId: string,
  args: { oldest: Date; limit: number }
): Promise<SlackMessage[]> {
  const { token, teamUrl } = await getSlackAccessToken(userId)
  const body = await slackApi(token, 'conversations.history', {
    channel: channelId,
    oldest: (args.oldest.getTime() / 1000).toFixed(6),
    limit: args.limit,
  })

  const messages = Array.isArray(body.messages) ? body.messages : []
  const out: SlackMessage[] = []
  for (const raw of messages) {
    const message = asRecord(raw)
    const ts = str(message.ts)
    if (!ts) continue
    const author = str(message.user) ?? ''
    out.push({
      channelId,
      channelName: null,
      ts,
      threadTs: str(message.thread_ts),
      userId: author,
      userName: author ? await userName(token, userId, author) : 'unknown',
      text: typeof message.text === 'string' ? message.text : '',
      permalink: permalinkFrom(teamUrl, channelId, ts),
    })
  }
  return out
}

/** Posts as the user (chat:write on a user token), then best-effort permalink. */
export async function postMessage(
  userId: string,
  args: { channel: string; text: string; threadTs?: string }
): Promise<{ channel: string; ts: string; permalink: string | null }> {
  const { token } = await getSlackAccessToken(userId)
  const body = await slackApi(
    token,
    'chat.postMessage',
    { channel: args.channel, text: args.text, thread_ts: args.threadTs },
    { post: true }
  )

  const channel = str(body.channel) ?? args.channel
  const ts = str(body.ts) ?? ''

  let permalink: string | null = null
  try {
    const link = await slackApi(token, 'chat.getPermalink', { channel, message_ts: ts })
    permalink = str(link.permalink)
  } catch {
    // Best-effort: a posted message without a permalink is still a success.
  }

  return { channel, ts, permalink }
}
