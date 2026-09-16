/**
 * Slack connect / callback / disconnect / status routes — spec §4.7. Mirrors
 * __tests__/api/me-google-routes.test.ts. (WI-3)
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = {
  userId: 'user-1',
  orgId: 'org-1',
  isApiKeyAuth: undefined as boolean | undefined,
}
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

const mockPrisma = vi.hoisted(() => ({
  slackCredential: { findUnique: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  apiKey: { findUnique: vi.fn() },
}))
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const oauth = vi.hoisted(() => ({
  buildSlackConsentUrl: vi.fn(),
  exchangeSlackCode: vi.fn(),
  revokeSlackToken: vi.fn(),
}))
vi.mock('../../src/lib/slack/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/slack/oauth')>()
  return {
    ...actual,
    buildSlackConsentUrl: (...a: unknown[]) => oauth.buildSlackConsentUrl(...a),
    exchangeSlackCode: (...a: unknown[]) => oauth.exchangeSlackCode(...a),
    revokeSlackToken: (...a: unknown[]) => oauth.revokeSlackToken(...a),
  }
})

const client = vi.hoisted(() => ({ authTest: vi.fn() }))
vi.mock('../../src/lib/slack/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/slack/client')>()
  return { ...actual, authTest: (...a: unknown[]) => client.authTest(...a) }
})

import { decryptSecret } from '../../src/lib/secrets'
import { SlackApiError, SlackInsufficientScopesError } from '../../src/lib/slack/errors'

function makeRequest(
  url: string,
  options: { method?: string; cookies?: Record<string, string>; bearer?: string } = {}
): NextRequest {
  const req = new NextRequest(url, {
    method: options.method ?? 'GET',
    headers: options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {},
  })
  for (const [name, value] of Object.entries(options.cookies ?? {})) req.cookies.set(name, value)
  return req
}

const EXCHANGE = {
  accessToken: 'xoxp-new',
  scopes: ['search:read'],
  teamId: 'T1',
  teamName: 'Acme',
  slackUserId: 'U123',
}

describe('Slack OAuth routes', () => {
  beforeAll(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64)
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    mockSession.isApiKeyAuth = undefined
    oauth.buildSlackConsentUrl.mockReturnValue('https://slack.com/oauth/v2/authorize?client_id=cid')
    oauth.exchangeSlackCode.mockResolvedValue(EXCHANGE)
    oauth.revokeSlackToken.mockResolvedValue(undefined)
    client.authTest.mockResolvedValue({
      userId: 'U123',
      teamId: 'T1',
      url: 'https://acme.slack.com/',
    })
    mockPrisma.slackCredential.findFirst.mockResolvedValue(null)
    mockPrisma.slackCredential.upsert.mockResolvedValue({})
  })

  describe('GET /api/me/slack/connect', () => {
    it('401 when unauthenticated', async () => {
      mockSession.userId = ''
      const { GET } = await import('../../src/app/api/me/slack/connect/route')
      expect((await GET(makeRequest('http://localhost/api/me/slack/connect'))).status).toBe(401)
    })

    it('403 for an API-key session (a mailbox-like credential needs a human)', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'k',
        orgId: 'org-1',
        agentName: 'bot',
        permissions: '[]',
        keyHash: 'any',
      })
      const { GET } = await import('../../src/app/api/me/slack/connect/route')
      const res = await GET(makeRequest('http://localhost/api/me/slack/connect', { bearer: 'key' }))
      expect(res.status).toBe(403)
    })

    it('302s to the consent URL and sets the state cookie', async () => {
      const { GET } = await import('../../src/app/api/me/slack/connect/route')
      const res = await GET(makeRequest('http://localhost/api/me/slack/connect'))
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toContain('slack.com/oauth/v2/authorize')
      const cookie = res.headers.get('Set-Cookie') ?? ''
      expect(cookie).toContain('slack_oauth_state=')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Path=/api/me/slack/callback')
      expect(cookie).toContain('Max-Age=600')
      const state = cookie.match(/slack_oauth_state=([^;]+)/)![1]
      expect(state.length).toBeGreaterThanOrEqual(32)
      expect(oauth.buildSlackConsentUrl).toHaveBeenCalledWith(state)
    })
  })

  describe('GET /api/me/slack/callback', () => {
    const state = 'state-abc'
    const cb = (query: string, cookies: Record<string, string> = { slack_oauth_state: state }) =>
      makeRequest(`http://localhost/api/me/slack/callback?${query}`, { cookies })

    it('400 STATE_MISMATCH when the cookie is missing or differs, clearing the cookie', async () => {
      const { GET } = await import('../../src/app/api/me/slack/callback/route')
      const res = await GET(cb(`code=c&state=${state}`, {}))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'STATE_MISMATCH' })
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0')
      const res2 = await GET(cb('code=c&state=other'))
      expect(res2.status).toBe(400)
    })

    it('redirects back with slack_error when the user cancelled', async () => {
      const { GET } = await import('../../src/app/api/me/slack/callback/route')
      const res = await GET(cb(`error=access_denied&state=${state}`))
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toContain(
        '/settings/integrations?slack_error=access_denied'
      )
      expect(oauth.exchangeSlackCode).not.toHaveBeenCalled()
    })

    it('400 INSUFFICIENT_SCOPES with the missing list', async () => {
      oauth.exchangeSlackCode.mockRejectedValue(new SlackInsufficientScopesError(['chat:write']))
      const { GET } = await import('../../src/app/api/me/slack/callback/route')
      const res = await GET(cb(`code=c&state=${state}`))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'INSUFFICIENT_SCOPES', missing: ['chat:write'] })
    })

    it('502 OAUTH_EXCHANGE_FAILED on any other exchange failure', async () => {
      oauth.exchangeSlackCode.mockRejectedValue(new SlackApiError('invalid_code'))
      const { GET } = await import('../../src/app/api/me/slack/callback/route')
      const res = await GET(cb(`code=c&state=${state}`))
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'OAUTH_EXCHANGE_FAILED' })
    })

    it('409 when the Slack identity is already bound to another mhud user', async () => {
      mockPrisma.slackCredential.findFirst.mockResolvedValue({
        userId: 'user-2',
        teamId: 'T1',
        slackUserId: 'U123',
      })
      const { GET } = await import('../../src/app/api/me/slack/callback/route')
      const res = await GET(cb(`code=c&state=${state}`))
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'SLACK_ACCOUNT_BOUND_TO_OTHER_USER' })
      expect(mockPrisma.slackCredential.upsert).not.toHaveBeenCalled()
    })

    it('stores the encrypted user token with the team identity and redirects to the integrations page', async () => {
      const { GET } = await import('../../src/app/api/me/slack/callback/route')
      const res = await GET(cb(`code=c&state=${state}`))
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toContain('/settings/integrations?connected=slack')
      expect(res.headers.get('Set-Cookie')).toContain('slack_oauth_state=')
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0')

      expect(oauth.exchangeSlackCode).toHaveBeenCalledWith('c')
      expect(client.authTest).toHaveBeenCalledWith('xoxp-new')
      const arg = mockPrisma.slackCredential.upsert.mock.calls[0][0]
      expect(arg.where).toEqual({ userId: 'user-1' })
      for (const branch of [arg.create, arg.update]) {
        expect(branch).toMatchObject({
          teamId: 'T1',
          teamName: 'Acme',
          teamUrl: 'https://acme.slack.com/',
          slackUserId: 'U123',
          scopes: 'search:read',
        })
        expect(decryptSecret(branch.accessTokenEncrypted)).toBe('xoxp-new')
        expect(branch).not.toHaveProperty('accessToken')
      }
      expect(arg.create.userId).toBe('user-1')
    })

    it('tolerates an auth.test failure (teamUrl null)', async () => {
      client.authTest.mockRejectedValue(new Error('down'))
      const { GET } = await import('../../src/app/api/me/slack/callback/route')
      const res = await GET(cb(`code=c&state=${state}`))
      expect(res.status).toBe(302)
      expect(mockPrisma.slackCredential.upsert.mock.calls[0][0].create.teamUrl).toBeNull()
    })

    it('re-binding the same Slack identity to the same user is allowed', async () => {
      mockPrisma.slackCredential.findFirst.mockResolvedValue({
        userId: 'user-1',
        teamId: 'T1',
        slackUserId: 'U123',
      })
      const { GET } = await import('../../src/app/api/me/slack/callback/route')
      expect((await GET(cb(`code=c&state=${state}`))).status).toBe(302)
    })
  })

  describe('DELETE /api/me/slack/disconnect', () => {
    it('204 idempotently, revoking when a credential exists', async () => {
      const { DELETE } = await import('../../src/app/api/me/slack/disconnect/route')
      mockPrisma.slackCredential.findUnique.mockResolvedValue(null)
      expect(
        (
          await DELETE(
            makeRequest('http://localhost/api/me/slack/disconnect', { method: 'DELETE' })
          )
        ).status
      ).toBe(204)
      expect(oauth.revokeSlackToken).not.toHaveBeenCalled()

      mockPrisma.slackCredential.findUnique.mockResolvedValue({ userId: 'user-1' })
      mockPrisma.slackCredential.delete.mockResolvedValue({})
      expect(
        (
          await DELETE(
            makeRequest('http://localhost/api/me/slack/disconnect', { method: 'DELETE' })
          )
        ).status
      ).toBe(204)
      expect(oauth.revokeSlackToken).toHaveBeenCalledWith('user-1')
      expect(mockPrisma.slackCredential.delete).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      })
    })

    it('still deletes and returns 204 when revoke rejects', async () => {
      const { DELETE } = await import('../../src/app/api/me/slack/disconnect/route')
      mockPrisma.slackCredential.findUnique.mockResolvedValue({ userId: 'user-1' })
      mockPrisma.slackCredential.delete.mockResolvedValue({})
      oauth.revokeSlackToken.mockRejectedValue(new Error('x'))
      expect(
        (
          await DELETE(
            makeRequest('http://localhost/api/me/slack/disconnect', { method: 'DELETE' })
          )
        ).status
      ).toBe(204)
      expect(mockPrisma.slackCredential.delete).toHaveBeenCalled()
    })

    it('401 when unauthenticated', async () => {
      mockSession.userId = ''
      const { DELETE } = await import('../../src/app/api/me/slack/disconnect/route')
      expect(
        (
          await DELETE(
            makeRequest('http://localhost/api/me/slack/disconnect', { method: 'DELETE' })
          )
        ).status
      ).toBe(401)
    })
  })

  describe('GET /api/me/slack/status', () => {
    it('reports disconnected / connected shapes', async () => {
      const { GET } = await import('../../src/app/api/me/slack/status/route')
      mockPrisma.slackCredential.findUnique.mockResolvedValue(null)
      expect(await (await GET(makeRequest('http://localhost/api/me/slack/status'))).json()).toEqual(
        { connected: false }
      )

      mockPrisma.slackCredential.findUnique.mockResolvedValue({
        userId: 'user-1',
        teamId: 'T1',
        teamName: 'Acme',
        teamUrl: 'https://acme.slack.com/',
        slackUserId: 'U123',
        accessTokenEncrypted: 'enc',
        scopes: 'search:read,chat:write',
        lastUsedAt: new Date('2026-09-16T08:00:00Z'),
      })
      const body = await (await GET(makeRequest('http://localhost/api/me/slack/status'))).json()
      expect(body).toEqual({
        connected: true,
        teamName: 'Acme',
        teamId: 'T1',
        slackUserId: 'U123',
        scopes: ['search:read', 'chat:write'],
        lastUsedAt: '2026-09-16T08:00:00.000Z',
      })
      expect(JSON.stringify(body)).not.toContain('enc')
    })
  })
})
