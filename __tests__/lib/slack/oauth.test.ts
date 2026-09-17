/**
 * Slack OAuth (user-token flow) — spec §4.7. Network goes through the shared
 * Slack fetch seam; the token store is Prisma (mocked) + real encryption. (WI-3)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  slackCredential: { findUnique: vi.fn(), update: vi.fn() },
}))
vi.mock('../../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

import {
  SLACK_USER_SCOPES,
  buildSlackConsentUrl,
  exchangeSlackCode,
  getSlackAccessToken,
  revokeSlackToken,
} from '../../../src/lib/slack/oauth'
import { __setSlackFetchForTests } from '../../../src/lib/slack/fetch'
import {
  SlackApiError,
  SlackAuthError,
  SlackInsufficientScopesError,
} from '../../../src/lib/slack/errors'
import { encryptSecret } from '../../../src/lib/secrets'

type Init = { method?: string; headers?: Record<string, string>; body?: string }
function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: Init }> = []
  const fetch = vi.fn(async (url: string, init?: Init) => {
    calls.push({ url, init })
    const text = JSON.stringify(body)
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => text,
      json: async () => body,
    }
  })
  return { fetch, calls }
}

describe('slack/oauth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SLACK_CLIENT_ID = 'cid'
    process.env.SLACK_CLIENT_SECRET = 'sec'
    process.env.SLACK_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/me/slack/callback'
    process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64)
    mockPrisma.slackCredential.update.mockResolvedValue({})
  })
  afterEach(() => {
    __setSlackFetchForTests(null)
    delete process.env.SLACK_CLIENT_ID
    delete process.env.SLACK_CLIENT_SECRET
    delete process.env.SLACK_OAUTH_REDIRECT_URI
  })

  it('names the user scopes the planner needs', () => {
    expect([...SLACK_USER_SCOPES]).toEqual([
      'search:read',
      'im:history',
      'im:read',
      'mpim:history',
      'mpim:read',
      'users:read',
      'chat:write',
      'channels:read',
      'groups:read',
    ])
  })

  describe('buildSlackConsentUrl', () => {
    it('builds the v2 authorize URL with user_scope (not bot scope), redirect and state', () => {
      const url = new URL(buildSlackConsentUrl('state-xyz'))
      expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
      expect(url.searchParams.get('client_id')).toBe('cid')
      expect(url.searchParams.get('user_scope')).toBe(SLACK_USER_SCOPES.join(','))
      expect(url.searchParams.get('scope')).toBeNull()
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/me/slack/callback'
      )
      expect(url.searchParams.get('state')).toBe('state-xyz')
    })

    it('throws at call time (not import time) when the env is missing', () => {
      delete process.env.SLACK_CLIENT_ID
      expect(() => buildSlackConsentUrl('s')).toThrow(/SLACK_OAUTH_\* env vars not configured/)
    })
  })

  describe('exchangeSlackCode', () => {
    it('POSTs the form to oauth.v2.access and returns the user token, scopes and team', async () => {
      const { fetch, calls } = fakeFetch({
        ok: true,
        authed_user: {
          id: 'U123',
          scope: SLACK_USER_SCOPES.join(','),
          access_token: 'xoxp-token',
          token_type: 'user',
        },
        team: { id: 'T1', name: 'Acme' },
      })
      __setSlackFetchForTests(fetch)
      const res = await exchangeSlackCode('code-1')
      expect(res).toEqual({
        accessToken: 'xoxp-token',
        scopes: [...SLACK_USER_SCOPES],
        teamId: 'T1',
        teamName: 'Acme',
        slackUserId: 'U123',
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://slack.com/api/oauth.v2.access')
      expect(calls[0].init?.method).toBe('POST')
      expect(calls[0].init?.headers?.['Content-Type']).toMatch(/application\/x-www-form-urlencoded/)
      const form = new URLSearchParams(calls[0].init?.body ?? '')
      expect(form.get('client_id')).toBe('cid')
      expect(form.get('client_secret')).toBe('sec')
      expect(form.get('code')).toBe('code-1')
      expect(form.get('redirect_uri')).toBe('http://localhost:3000/api/me/slack/callback')
    })

    it('maps ok:false to SlackApiError carrying the Slack error code', async () => {
      __setSlackFetchForTests(fakeFetch({ ok: false, error: 'invalid_code' }).fetch)
      const err = await exchangeSlackCode('bad').catch((e) => e)
      expect(err).toBeInstanceOf(SlackApiError)
      expect((err as SlackApiError).slackError).toBe('invalid_code')
    })

    it('throws SlackInsufficientScopesError listing the scopes the user did not grant', async () => {
      __setSlackFetchForTests(
        fakeFetch({
          ok: true,
          authed_user: {
            id: 'U1',
            scope: 'search:read,users:read',
            access_token: 'xoxp',
            token_type: 'user',
          },
          team: { id: 'T1', name: 'Acme' },
        }).fetch
      )
      const err = await exchangeSlackCode('c').catch((e) => e)
      expect(err).toBeInstanceOf(SlackInsufficientScopesError)
      expect((err as SlackInsufficientScopesError).missing).toEqual(
        SLACK_USER_SCOPES.filter((s) => s !== 'search:read' && s !== 'users:read')
      )
    })

    it('rejects a response without a user token', async () => {
      __setSlackFetchForTests(fakeFetch({ ok: true, team: { id: 'T1', name: 'Acme' } }).fetch)
      await expect(exchangeSlackCode('c')).rejects.toThrow()
    })
  })

  describe('getSlackAccessToken', () => {
    it('decrypts the stored user token and returns the identity fields', async () => {
      mockPrisma.slackCredential.findUnique.mockResolvedValue({
        userId: 'user-1',
        teamId: 'T1',
        teamName: 'Acme',
        teamUrl: 'https://acme.slack.com/',
        slackUserId: 'U123',
        accessTokenEncrypted: encryptSecret('xoxp-secret'),
        scopes: 'search:read',
      })
      const res = await getSlackAccessToken('user-1')
      expect(res).toEqual({
        token: 'xoxp-secret',
        slackUserId: 'U123',
        teamId: 'T1',
        teamUrl: 'https://acme.slack.com/',
      })
      expect(mockPrisma.slackCredential.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } })
      )
    })

    it('throws SlackAuthError when the user has no credential', async () => {
      mockPrisma.slackCredential.findUnique.mockResolvedValue(null)
      await expect(getSlackAccessToken('user-1')).rejects.toBeInstanceOf(SlackAuthError)
    })
  })

  describe('revokeSlackToken', () => {
    it('posts auth.revoke with the bearer token and never throws', async () => {
      mockPrisma.slackCredential.findUnique.mockResolvedValue({
        userId: 'user-1',
        teamId: 'T1',
        teamName: 'Acme',
        teamUrl: null,
        slackUserId: 'U1',
        accessTokenEncrypted: encryptSecret('xoxp-r'),
        scopes: '',
      })
      const { fetch, calls } = fakeFetch({ ok: true, revoked: true })
      __setSlackFetchForTests(fetch)
      await expect(revokeSlackToken('user-1')).resolves.toBeUndefined()
      expect(calls[0].url).toMatch(/^https:\/\/slack\.com\/api\/auth\.revoke/)
      expect(calls[0].init?.headers?.Authorization).toBe('Bearer xoxp-r')
    })

    it('is a no-op without a credential and swallows network failures', async () => {
      mockPrisma.slackCredential.findUnique.mockResolvedValue(null)
      const { fetch } = fakeFetch({})
      __setSlackFetchForTests(fetch)
      await expect(revokeSlackToken('user-1')).resolves.toBeUndefined()
      expect(fetch).not.toHaveBeenCalled()

      mockPrisma.slackCredential.findUnique.mockResolvedValue({
        userId: 'user-1',
        teamId: 'T1',
        teamName: 'Acme',
        teamUrl: null,
        slackUserId: 'U1',
        accessTokenEncrypted: encryptSecret('xoxp-r'),
        scopes: '',
      })
      __setSlackFetchForTests(vi.fn().mockRejectedValue(new Error('network')))
      await expect(revokeSlackToken('user-1')).resolves.toBeUndefined()
    })
  })
})
