/**
 * Slack source (spec §4.5 slack.ts): mentions via search, DMs awaiting a reply
 * via paginated conversation listing, lookback, and honest resolution. (WI-3)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  slackCredential: { findUnique: vi.fn() },
}))
vi.mock('../../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const client = vi.hoisted(() => ({
  searchMentions: vi.fn(),
  listDmConversations: vi.fn(),
  conversationHistory: vi.fn(),
}))
vi.mock('../../../src/lib/slack/client', () => ({
  searchMentions: (...a: unknown[]) => client.searchMentions(...a),
  listDmConversations: (...a: unknown[]) => client.listDmConversations(...a),
  conversationHistory: (...a: unknown[]) => client.conversationHistory(...a),
}))

import { readSlack } from '../../../src/lib/planner/sources/slack'
import type { SlackMessage } from '../../../src/lib/slack/client'
import type { SourceContext } from '../../../src/lib/planner/types'
import { dayBounds } from '../../../src/lib/planner/time'

const NOW = new Date('2026-09-16T09:00:00Z')
const CTX: SourceContext = {
  userId: 'user-1',
  orgId: 'org-1',
  tz: 'UTC',
  now: NOW,
  window: dayBounds('2026-09-16', 'UTC'),
}
const HOUR = 60 * 60 * 1000

function msg(over: Partial<SlackMessage> = {}): SlackMessage {
  return {
    channelId: 'D1',
    channelName: null,
    ts: '1789720000.000100',
    threadTs: null,
    userId: 'U2',
    userName: 'Jane',
    text: 'can you review the deck before 3?',
    permalink: 'https://acme.slack.com/archives/D1/p1789720000000100',
    ...over,
  }
}

describe('planner/sources/slack', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('PLANNER_SLACK_LOOKBACK_HOURS', '')
    vi.stubEnv('PLANNER_SLACK_MAX_DM_CONVERSATIONS', '')
    mockPrisma.slackCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      slackUserId: 'U_ME',
      teamId: 'T1',
      teamUrl: 'https://acme.slack.com',
    })
    client.searchMentions.mockResolvedValue([])
    client.listDmConversations.mockResolvedValue({ conversations: [], truncated: false })
    client.conversationHistory.mockResolvedValue([])
  })

  it('returns null (skipped) without calling Slack when the user has no credential', async () => {
    mockPrisma.slackCredential.findUnique.mockResolvedValue(null)
    expect(await readSlack(CTX)).toBeNull()
    expect(client.searchMentions).not.toHaveBeenCalled()
  })

  it('uses a 48h lookback by default (env overrides) for both mentions and DM history', async () => {
    await readSlack(CTX)
    expect(client.searchMentions).toHaveBeenCalledWith('user-1', {
      slackUserId: 'U_ME',
      oldest: new Date(NOW.getTime() - 48 * HOUR),
    })

    vi.stubEnv('PLANNER_SLACK_LOOKBACK_HOURS', '6')
    client.listDmConversations.mockResolvedValue({
      conversations: [{ id: 'D1', isMpim: false, userId: 'U2' }],
      truncated: false,
    })
    await readSlack(CTX)
    expect(client.searchMentions).toHaveBeenLastCalledWith('user-1', {
      slackUserId: 'U_ME',
      oldest: new Date(NOW.getTime() - 6 * HOUR),
    })
    expect(client.conversationHistory).toHaveBeenCalledWith('user-1', 'D1', {
      oldest: new Date(NOW.getTime() - 6 * HOUR),
      limit: 20,
    })
  })

  it('maps mentions to items with the channel in the title', async () => {
    client.searchMentions.mockResolvedValue([
      msg({
        channelId: 'C1',
        channelName: 'general',
        ts: '1789721000.000100',
        text: 'hey <@U_ME> thoughts on the plan?',
      }),
    ])
    const read = await readSlack(CTX)
    expect(read!.items).toEqual([
      {
        sourceKey: 'slack:C1:1789721000.000100',
        title: 'Jane in #general: hey <@U_ME> thoughts on the plan?',
        summary: 'hey <@U_ME> thoughts on the plan?',
        url: 'https://acme.slack.com/archives/D1/p1789720000000100',
        payload: {
          channelId: 'C1',
          channelName: 'general',
          ts: '1789721000.000100',
          threadTs: null,
          slackUserId: 'U2',
          userName: 'Jane',
          text: 'hey <@U_ME> thoughts on the plan?',
          kind: 'mention',
        },
      },
    ])
  })

  it('maps a DM whose latest message is from someone else; skips one the user answered last', async () => {
    client.listDmConversations.mockResolvedValue({
      conversations: [
        { id: 'D1', isMpim: false, userId: 'U2' },
        { id: 'D2', isMpim: false, userId: 'U3' },
      ],
      truncated: false,
    })
    client.conversationHistory.mockImplementation(async (_u: string, channel: string) =>
      channel === 'D1'
        ? [
            msg({ channelId: 'D1', ts: '1789722000.000200', userId: 'U2', userName: 'Jane' }),
            msg({ channelId: 'D1', ts: '1789721000.000100', userId: 'U_ME', userName: 'Me' }),
          ]
        : [
            msg({
              channelId: 'D2',
              ts: '1789723000.000200',
              userId: 'U_ME',
              userName: 'Me',
              text: 'done!',
            }),
            msg({ channelId: 'D2', ts: '1789722500.000100', userId: 'U3' }),
          ]
    )
    const read = await readSlack(CTX)
    expect(read!.items.map((i) => i.sourceKey)).toEqual(['slack:D1:1789722000.000200'])
    expect(read!.items[0].title).toBe('Jane: can you review the deck before 3?')
    expect(read!.items[0].payload).toMatchObject({
      kind: 'dm',
      channelId: 'D1',
      ts: '1789722000.000200',
    })
  })

  it('truncates long titles (80 chars of text) and summaries/text (500 / 4000)', async () => {
    const long = 'x'.repeat(5000)
    client.searchMentions.mockResolvedValue([
      msg({ channelId: 'C1', channelName: 'g', text: long }),
    ])
    const [item] = (await readSlack(CTX))!.items
    expect(item.title).toBe(`Jane in #g: ${'x'.repeat(80)}`)
    expect((item.summary as string).length).toBe(500)
    expect((item.payload.text as string).length).toBe(4000)
  })

  it('orders conversations by updated desc and fetches history for at most PLANNER_SLACK_MAX_DM_CONVERSATIONS', async () => {
    vi.stubEnv('PLANNER_SLACK_MAX_DM_CONVERSATIONS', '2')
    client.listDmConversations.mockResolvedValue({
      conversations: [
        { id: 'D-old', isMpim: false, updated: 1 },
        { id: 'D-new', isMpim: false, updated: 300 },
        { id: 'D-mid', isMpim: false, updated: 200 },
      ],
      truncated: false,
    })
    const read = await readSlack(CTX)
    const visited = client.conversationHistory.mock.calls.map((c) => c[1])
    expect(visited).toEqual(['D-new', 'D-mid'])
    // more conversations than we read → no authority to resolve absent items
    expect(read!.resolveMissing).toBe('none')
  })

  it('resolves only open items by absence when every conversation was read', async () => {
    client.listDmConversations.mockResolvedValue({
      conversations: [{ id: 'D1', isMpim: false }],
      truncated: false,
    })
    const read = await readSlack(CTX)
    expect(read!.resolveMissing).toBe('open')
  })

  it('claims no resolution authority when the listing was truncated', async () => {
    client.listDmConversations.mockResolvedValue({
      conversations: [{ id: 'D1', isMpim: false }],
      truncated: true,
    })
    const read = await readSlack(CTX)
    expect(read!.resolveMissing).toBe('none')
  })

  it('dedupes a DM that is also a mention (same channel + ts)', async () => {
    client.searchMentions.mockResolvedValue([msg({ channelId: 'D1', ts: '1789722000.000200' })])
    client.listDmConversations.mockResolvedValue({
      conversations: [{ id: 'D1', isMpim: false }],
      truncated: false,
    })
    client.conversationHistory.mockResolvedValue([
      msg({ channelId: 'D1', ts: '1789722000.000200' }),
    ])
    const read = await readSlack(CTX)
    expect(read!.items).toHaveLength(1)
  })
})
