/**
 * Google connect `?upgrade=planner` and the status route's `plannerScopes`
 * (spec §4.6 routes). The two-argument `buildConsentUrl` call must stay
 * byte-identical for the ordinary connect. (WI-2)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = { userId: 'user-1', orgId: 'org-1' }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

const mockPrisma = vi.hoisted(() => ({
  googleCredential: { findUnique: vi.fn() },
}))
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const oauth = vi.hoisted(() => ({ buildConsentUrl: vi.fn() }))
vi.mock('../../src/lib/google/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/google/oauth')>()
  return { ...actual, buildConsentUrl: (...a: unknown[]) => oauth.buildConsentUrl(...a) }
})

import {
  CALENDAR_EVENTS_READONLY_SCOPE,
  DRIVE_FILE_SCOPE,
  PLANNER_SCOPES,
} from '../../src/lib/google/scopes'

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' })
}

describe('GET /api/me/google/connect — planner scope upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    oauth.buildConsentUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?x=1')
  })

  it('without ?upgrade calls buildConsentUrl with exactly two arguments', async () => {
    const { GET } = await import('../../src/app/api/me/google/connect/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/connect'))
    expect(res.status).toBe(302)
    expect(oauth.buildConsentUrl).toHaveBeenCalledTimes(1)
    const call = oauth.buildConsentUrl.mock.calls[0]
    expect(call).toHaveLength(2)
    expect(call[0]).toBe('user-1')
    expect(typeof call[1]).toBe('string')
  })

  it('with ?upgrade=planner passes PLANNER_SCOPES as the third argument and still sets the state cookie', async () => {
    const { GET } = await import('../../src/app/api/me/google/connect/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/connect?upgrade=planner'))
    expect(res.status).toBe(302)
    const call = oauth.buildConsentUrl.mock.calls[0]
    expect(call[0]).toBe('user-1')
    expect(call[2]).toEqual([...PLANNER_SCOPES])
    expect(res.headers.get('Set-Cookie')).toContain('google_oauth_state=')
    expect(res.headers.get('Location')).toContain('accounts.google.com')
  })

  it('ignores unknown upgrade values (two-argument call)', async () => {
    const { GET } = await import('../../src/app/api/me/google/connect/route')
    await GET(makeRequest('http://localhost/api/me/google/connect?upgrade=other'))
    expect(oauth.buildConsentUrl.mock.calls[0]).toHaveLength(2)
  })
})

describe('GET /api/me/google/status — plannerScopes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
  })

  it('reports missing planner scopes on an M4-only credential', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      googleEmail: 'me@example.com',
      scopes:
        'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly',
      accessToken: 'enc',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      lastUsedAt: null,
    })
    const { GET } = await import('../../src/app/api/me/google/status/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/status'))
    const body = await res.json()
    expect(body.connected).toBe(true)
    expect(body.plannerScopes).toEqual({
      granted: false,
      missing: [CALENDAR_EVENTS_READONLY_SCOPE, DRIVE_FILE_SCOPE],
    })
  })

  it('reports granted when both planner scopes are present', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      googleEmail: 'me@example.com',
      scopes: `https://www.googleapis.com/auth/drive.readonly ${CALENDAR_EVENTS_READONLY_SCOPE} ${DRIVE_FILE_SCOPE}`,
      accessToken: 'enc',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      lastUsedAt: null,
    })
    const { GET } = await import('../../src/app/api/me/google/status/route')
    const body = await (await GET(makeRequest('http://localhost/api/me/google/status'))).json()
    expect(body.plannerScopes).toEqual({ granted: true, missing: [] })
  })

  it('keeps the disconnected shape unchanged', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(null)
    const { GET } = await import('../../src/app/api/me/google/status/route')
    const body = await (await GET(makeRequest('http://localhost/api/me/google/status'))).json()
    expect(body).toEqual({ connected: false })
  })
})
