/**
 * Slack Web API client — spec §4.8. All network through the fetch seam;
 * token resolution through the mocked oauth module. (WI-3)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const oauth = vi.hoisted(() => ({ getSlackAccessToken: vi.fn() }))
vi.mock('../../../src/lib/slack/oauth', () => ({
  getSlackAccessToken: (...a: unknown[]) => oauth.getSlackAccessToken(...a),
}))

import {
  __resetSlackCachesForTests,
  authTest,
  conversationHistory,
  listDmConversations,
  postMessage,
  resolveUserName,
  searchMentions,
  slackApi,
} from '../../../src/lib/slack/client'
import { __setSlackFetchForTests, __setSlackSleeperForTests } from '../../../src/lib/slack/fetch'
import { SlackApiError, SlackHttpError } from '../../../src/lib/slack/errors'

type Init = { method?: string; headers?: Record<string, string>; body?: string }
type Call = { url: string; init?: Init }
type Reply = { status?: number; body: unknown; retryAfter?: string }

/** Routes by API method name (the path segment after /api/). */
function router(handlers: Record<string, Reply | Reply[] | ((call: Call, n: number) => Reply)>) {
  const calls: Call[] = []
  const counts: Record<string, number> = {}
  const fetch = vi.fn(async (url: string, init?: Init) => {
    const call = { url, init }
    calls.push(call)
    const method = new URL(url).pathname.replace('/api/', '')
    counts[method] = (counts[method] ?? 0) + 1
    const h = handlers[method]
    if (!h) throw new Error(`Unmatched Slack method: ${method}`)
    const reply: Reply =
      typeof h === 'function'
        ? h(call, counts[method])
        : Array.isArray(h)
          ? h[Math.min(counts[method] - 1, h.length - 1)]
          : h
    const status = reply.status ?? 200
    const text = JSON.stringify(reply.body)
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' ? (reply.retryAfter ?? null) : null,
      },
      text: async () => text,
      json: async () => reply.body,
    }
  })
  return { fetch, calls, counts }
}

const q = (call: Call) => new URL(call.url).searchParams

describe('slack/client', () => {
  const sleeper = vi.fn(async () => {})
  beforeEach(() => {
    vi.clearAllMocks()
    __resetSlackCachesForTests()
    __setSlackSleeperForTests(sleeper)
    oauth.getSlackAccessToken.mockResolvedValue({
      token: 'xoxp-t',
      slackUserId: 'U_ME',
      teamId: 'T1',
      teamUrl: 'https://acme.slack.com',
    })
  })
  afterEach(() => {
    __setSlackFetchForTests(null)
    __setSlackSleeperForTests(null)
  })

  describe('slackApi', () => {
    it('GETs reads with a query string and the bearer token, omitting undefined params', async () => {
      const { fetch, calls } = router({ 'users.info': { body: { ok: true, user: { id: 'U2' } } } })
      __setSlackFetchForTests(fetch)
      const res = await slackApi<{ ok: true; user: { id: string } }>('tok', 'users.info', {
        user: 'U2',
        include_locale: undefined,
      })
      expect(res.user.id).toBe('U2')
      expect(calls[0].init?.method ?? 'GET').toBe('GET')
      expect(new URL(calls[0].url).origin + new URL(calls[0].url).pathname).toBe(
        'https://slack.com/api/users.info'
      )
      expect(q(calls[0]).get('user')).toBe('U2')
      expect(q(calls[0]).has('include_locale')).toBe(false)
      expect(calls[0].init?.headers?.Authorization).toBe('Bearer tok')
    })

    it('POSTs writes as JSON', async () => {
      const { fetch, calls } = router({
        'chat.postMessage': { body: { ok: true, ts: '1.2', channel: 'C1' } },
      })
      __setSlackFetchForTests(fetch)
      await slackApi('tok', 'chat.postMessage', { channel: 'C1', text: 'hi' }, { post: true })
      expect(calls[0].url).toBe('https://slack.com/api/chat.postMessage')
      expect(calls[0].init?.method).toBe('POST')
      expect(calls[0].init?.headers?.['Content-Type']).toMatch(/^application\/json/)
      expect(JSON.parse(calls[0].init?.body ?? '{}')).toEqual({ channel: 'C1', text: 'hi' })
    })

    it('maps ok:false to SlackApiError with the Slack error code', async () => {
      __setSlackFetchForTests(
        router({ 'users.info': { body: { ok: false, error: 'user_not_found' } } }).fetch
      )
      const err = await slackApi('tok', 'users.info', { user: 'U9' }).catch((e) => e)
      expect(err).toBeInstanceOf(SlackApiError)
      expect((err as SlackApiError).slackError).toBe('user_not_found')
    })

    it('on 429 sleeps min(Retry-After, 5s) once and retries; a second 429 is a SlackHttpError', async () => {
      const { fetch } = router({
        'users.info': [
          { status: 429, body: {}, retryAfter: '2' },
          { body: { ok: true, user: {} } },
        ],
      })
      __setSlackFetchForTests(fetch)
      await slackApi('tok', 'users.info', { user: 'U1' })
      expect(sleeper).toHaveBeenCalledWith(2000)
      expect(fetch).toHaveBeenCalledTimes(2)

      sleeper.mockClear()
      const twice = router({ 'users.info': { status: 429, body: {}, retryAfter: '30' } })
      __setSlackFetchForTests(twice.fetch)
      const err = await slackApi('tok', 'users.info', { user: 'U1' }).catch((e) => e)
      expect(err).toBeInstanceOf(SlackHttpError)
      expect((err as SlackHttpError).status).toBe(429)
      expect(sleeper).toHaveBeenCalledTimes(1)
      expect(sleeper).toHaveBeenCalledWith(5000)
      expect(twice.fetch).toHaveBeenCalledTimes(2)
    })

    it('maps other non-2xx statuses to SlackHttpError without retrying', async () => {
      const { fetch } = router({ 'users.info': { status: 500, body: 'boom' } })
      __setSlackFetchForTests(fetch)
      await expect(slackApi('tok', 'users.info', { user: 'U1' })).rejects.toBeInstanceOf(
        SlackHttpError
      )
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  it('authTest returns the identity fields', async () => {
    __setSlackFetchForTests(
      router({
        'auth.test': {
          body: { ok: true, url: 'https://acme.slack.com/', team_id: 'T1', user_id: 'U_ME' },
        },
      }).fetch
    )
    expect(await authTest('xoxp-t')).toEqual({
      userId: 'U_ME',
      teamId: 'T1',
      url: 'https://acme.slack.com/',
    })
  })

  describe('searchMentions', () => {
    it('searches for the user mention after the lookback date, newest first, and maps matches', async () => {
      const { fetch, calls } = router({
        'search.messages': {
          body: {
            ok: true,
            messages: {
              matches: [
                {
                  ts: '1789730000.000100',
                  text: 'hey <@U_ME> can you look?',
                  channel: { id: 'C1', name: 'general' },
                  user: 'U2',
                  username: 'jane',
                  permalink: 'https://acme.slack.com/archives/C1/p1789730000000100',
                },
                {
                  ts: '1000000000.000000',
                  text: 'ancient',
                  channel: { id: 'C1', name: 'general' },
                  user: 'U3',
                  username: 'old',
                  permalink: 'https://acme.slack.com/archives/C1/p1000000000000000',
                },
              ],
            },
          },
        },
      })
      __setSlackFetchForTests(fetch)
      const oldest = new Date('2026-09-14T09:00:00Z') // 1789722000
      const res = await searchMentions('user-1', { slackUserId: 'U_ME', oldest })
      expect(oauth.getSlackAccessToken).toHaveBeenCalledWith('user-1')
      expect(q(calls[0]).get('query')).toBe('<@U_ME> after:2026-09-13')
      expect(q(calls[0]).get('sort')).toBe('timestamp')
      expect(q(calls[0]).get('sort_dir')).toBe('desc')
      expect(q(calls[0]).get('count')).toBe('20')
      expect(res.truncated).toBe(false)
      expect(res.messages).toEqual([
        {
          channelId: 'C1',
          channelName: 'general',
          ts: '1789730000.000100',
          threadTs: null,
          userId: 'U2',
          userName: 'jane',
          text: 'hey <@U_ME> can you look?',
          permalink: 'https://acme.slack.com/archives/C1/p1789730000000100',
        },
      ])
    })

    it('reports truncation when Slack has more pages or a larger total than the page', async () => {
      const match = {
        ts: '1789730000.000100',
        text: 'hey <@U_ME>',
        channel: { id: 'C1', name: 'general' },
        user: 'U2',
        username: 'jane',
        permalink: 'https://acme.slack.com/archives/C1/p1789730000000100',
      }
      const paged = router({
        'search.messages': {
          body: { ok: true, messages: { matches: [match], total: 21, paging: { pages: 2 } } },
        },
      })
      __setSlackFetchForTests(paged.fetch)
      const oldest = new Date('2026-09-14T09:00:00Z')
      const a = await searchMentions('user-1', { slackUserId: 'U_ME', oldest })
      expect(a.truncated).toBe(true)
      expect(a.messages).toHaveLength(1)

      const single = router({
        'search.messages': {
          body: { ok: true, messages: { matches: [match], total: 1, paging: { pages: 1 } } },
        },
      })
      __setSlackFetchForTests(single.fetch)
      const b = await searchMentions('user-1', { slackUserId: 'U_ME', oldest })
      expect(b.truncated).toBe(false)
    })
  })

  describe('listDmConversations', () => {
    it('pages through conversations.list until the cursor is empty and skips deleted users', async () => {
      const { fetch, calls } = router({
        'conversations.list': [
          {
            body: {
              ok: true,
              channels: [
                { id: 'D1', is_im: true, user: 'U2', updated: 1789700000000, priority: 0.5 },
                { id: 'D2', is_im: true, user: 'U9', is_user_deleted: true },
              ],
              response_metadata: { next_cursor: 'c2' },
            },
          },
          {
            body: {
              ok: true,
              channels: [{ id: 'G1', is_mpim: true, updated: 1789600000000 }],
              response_metadata: { next_cursor: '' },
            },
          },
        ],
      })
      __setSlackFetchForTests(fetch)
      const res = await listDmConversations('user-1')
      expect(q(calls[0]).get('types')).toBe('im,mpim')
      expect(q(calls[0]).get('exclude_archived')).toBe('true')
      expect(q(calls[0]).get('limit')).toBe('200')
      expect(q(calls[0]).has('cursor')).toBe(false)
      expect(q(calls[1]).get('cursor')).toBe('c2')
      expect(res).toEqual({
        conversations: [
          { id: 'D1', isMpim: false, userId: 'U2', updated: 1789700000000, priority: 0.5 },
          {
            id: 'G1',
            isMpim: true,
            userId: undefined,
            updated: 1789600000000,
            priority: undefined,
          },
        ],
        truncated: false,
      })
    })

    it('reports truncated when maxPages is hit with a cursor remaining', async () => {
      const { fetch } = router({
        'conversations.list': {
          body: {
            ok: true,
            channels: [{ id: 'D1', is_im: true }],
            response_metadata: { next_cursor: 'more' },
          },
        },
      })
      __setSlackFetchForTests(fetch)
      const res = await listDmConversations('user-1', { maxPages: 2 })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(res.truncated).toBe(true)
      expect(res.conversations).toHaveLength(2)
    })
  })

  describe('conversationHistory', () => {
    it('reads history after `oldest`, resolves user names once per user, and builds permalinks from the team url', async () => {
      const { fetch, calls, counts } = router({
        'conversations.history': {
          body: {
            ok: true,
            messages: [
              { ts: '1789730000.000200', user: 'U2', text: 'ping', thread_ts: '1789729000.000100' },
              { ts: '1789729000.000100', user: 'U2', text: 'first' },
              { ts: '1789728000.000100', user: 'U_ME', text: 'mine' },
            ],
          },
        },
        'users.info': (call) => ({
          body: {
            ok: true,
            user: {
              id: q(call).get('user'),
              name: 'handle',
              real_name: `Real ${q(call).get('user')}`,
              profile: { display_name: '' },
            },
          },
        }),
      })
      __setSlackFetchForTests(fetch)
      const oldest = new Date('2026-09-14T09:00:00Z')
      const res = await conversationHistory('user-1', 'D1', { oldest, limit: 20 })
      const hist = calls.find((c) => c.url.includes('conversations.history'))!
      expect(q(hist).get('channel')).toBe('D1')
      expect(q(hist).get('limit')).toBe('20')
      expect(Number(q(hist).get('oldest'))).toBeCloseTo(oldest.getTime() / 1000, 0)
      expect(res).toEqual([
        {
          channelId: 'D1',
          channelName: null,
          ts: '1789730000.000200',
          threadTs: '1789729000.000100',
          userId: 'U2',
          userName: 'Real U2',
          text: 'ping',
          permalink: 'https://acme.slack.com/archives/D1/p1789730000000200',
        },
        {
          channelId: 'D1',
          channelName: null,
          ts: '1789729000.000100',
          threadTs: null,
          userId: 'U2',
          userName: 'Real U2',
          text: 'first',
          permalink: 'https://acme.slack.com/archives/D1/p1789729000000100',
        },
        {
          channelId: 'D1',
          channelName: null,
          ts: '1789728000.000100',
          threadTs: null,
          userId: 'U_ME',
          userName: 'Real U_ME',
          text: 'mine',
          permalink: 'https://acme.slack.com/archives/D1/p1789728000000100',
        },
      ])
      expect(counts['users.info']).toBe(2) // U2 memoised, U_ME once
    })
  })

  it('resolveUserName prefers display_name, then real_name, then name, and memoises', async () => {
    const { fetch, counts } = router({
      'users.info': (call) => {
        const id = q(call).get('user')
        if (id === 'U_D')
          return {
            body: {
              ok: true,
              user: { id, name: 'n', real_name: 'r', profile: { display_name: 'Display' } },
            },
          }
        if (id === 'U_R')
          return {
            body: {
              ok: true,
              user: { id, name: 'n', real_name: 'Real', profile: { display_name: '' } },
            },
          }
        return { body: { ok: true, user: { id, name: 'handle' } } }
      },
    })
    __setSlackFetchForTests(fetch)
    expect(await resolveUserName('user-1', 'U_D')).toBe('Display')
    expect(await resolveUserName('user-1', 'U_R')).toBe('Real')
    expect(await resolveUserName('user-1', 'U_N')).toBe('handle')
    await resolveUserName('user-1', 'U_D')
    expect(counts['users.info']).toBe(3)
  })

  describe('postMessage', () => {
    it('posts as the user, threads when asked, and returns the permalink', async () => {
      const { fetch, calls } = router({
        'chat.postMessage': { body: { ok: true, channel: 'C1', ts: '1789731000.000300' } },
        'chat.getPermalink': {
          body: { ok: true, permalink: 'https://acme.slack.com/archives/C1/p1789731000000300' },
        },
      })
      __setSlackFetchForTests(fetch)
      const res = await postMessage('user-1', {
        channel: 'C1',
        text: 'hello *there*',
        threadTs: '1789730000.000100',
      })
      const post = calls.find((c) => c.url.endsWith('chat.postMessage'))!
      expect(post.init?.method).toBe('POST')
      expect(JSON.parse(post.init?.body ?? '{}')).toEqual({
        channel: 'C1',
        text: 'hello *there*',
        thread_ts: '1789730000.000100',
      })
      const perma = calls.find((c) => c.url.includes('chat.getPermalink'))!
      expect(q(perma).get('channel')).toBe('C1')
      expect(q(perma).get('message_ts')).toBe('1789731000.000300')
      expect(res).toEqual({
        channel: 'C1',
        ts: '1789731000.000300',
        permalink: 'https://acme.slack.com/archives/C1/p1789731000000300',
      })
    })

    it('tolerates a failing getPermalink (permalink null) and surfaces a failed post', async () => {
      __setSlackFetchForTests(
        router({
          'chat.postMessage': { body: { ok: true, channel: 'C1', ts: '1.1' } },
          'chat.getPermalink': { body: { ok: false, error: 'message_not_found' } },
        }).fetch
      )
      expect(await postMessage('user-1', { channel: 'C1', text: 'x' })).toEqual({
        channel: 'C1',
        ts: '1.1',
        permalink: null,
      })

      __setSlackFetchForTests(
        router({ 'chat.postMessage': { body: { ok: false, error: 'not_in_channel' } } }).fetch
      )
      await expect(postMessage('user-1', { channel: 'C1', text: 'x' })).rejects.toBeInstanceOf(
        SlackApiError
      )
    })
  })
})
