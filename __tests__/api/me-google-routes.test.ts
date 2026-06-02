/**
 * Tests for GET /api/me/google/connect
 *             GET /api/me/google/callback
 *             DELETE /api/me/google/disconnect
 *             GET /api/me/google/status
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { NextRequest } from 'next/server'
import { decryptSecret } from '../../src/lib/secrets'

beforeAll(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64)
})

// ─── Session mock ────────────────────────────────────────────────────────────

const mockSession = {
  userId: 'user-1',
  orgId: 'org-1',
}

vi.mock('iron-session', () => ({
  getIronSession: vi.fn().mockResolvedValue(mockSession),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockReturnValue({}),
}))

// ─── Prisma mock ─────────────────────────────────────────────────────────────

const mockPrisma = {
  googleCredential: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
}

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

// ─── Google OAuth mock ───────────────────────────────────────────────────────

const mockBuildConsentUrl = vi.fn()
const mockExchangeCode = vi.fn()
const mockRevokeRefreshToken = vi.fn()

vi.mock('../../src/lib/google/oauth', () => ({
  buildConsentUrl: (...args: unknown[]) => mockBuildConsentUrl(...args),
  exchangeCode: (...args: unknown[]) => mockExchangeCode(...args),
  revokeRefreshToken: (...args: unknown[]) => mockRevokeRefreshToken(...args),
  REQUIRED_SCOPES: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/documents.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/presentations.readonly',
  ],
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
]

function makeExchangeResult(overrides: Partial<{
  accessToken: string
  refreshToken: string
  expiresAt: Date
  email: string
  sub: string
  scopes: string[]
}> = {}) {
  return {
    accessToken: 'access-token-123',
    refreshToken: 'refresh-token-abc',
    expiresAt: new Date(Date.now() + 3600_000),
    email: 'user@example.com',
    sub: 'google-sub-1',
    scopes: REQUIRED_SCOPES,
    ...overrides,
  }
}

function makeRequest(
  url: string,
  options: { method?: string; cookies?: Record<string, string> } = {}
): NextRequest {
  const req = new NextRequest(url, { method: options.method ?? 'GET' })
  if (options.cookies) {
    for (const [name, value] of Object.entries(options.cookies)) {
      req.cookies.set(name, value)
    }
  }
  return req
}

// ─── connect ─────────────────────────────────────────────────────────────────

describe('GET /api/me/google/connect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    mockBuildConsentUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?mock=1')
  })

  it('returns 401 when unauthenticated', async () => {
    mockSession.userId = ''
    const { GET } = await import('../../src/app/api/me/google/connect/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/connect'))
    expect(res.status).toBe(401)
  })

  it('302 to consent URL; Set-Cookie contains google_oauth_state hex', async () => {
    const { GET } = await import('../../src/app/api/me/google/connect/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/connect'))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('accounts.google.com')
    const cookie = res.headers.get('Set-Cookie') ?? ''
    expect(cookie).toContain('google_oauth_state=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=600')
  })

  it('state value passed to buildConsentUrl matches cookie value', async () => {
    const { GET } = await import('../../src/app/api/me/google/connect/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/connect'))
    const cookie = res.headers.get('Set-Cookie') ?? ''
    const stateFromCookie = cookie.match(/google_oauth_state=([^;]+)/)?.[1] ?? ''
    expect(stateFromCookie).toBeTruthy()
    expect(mockBuildConsentUrl).toHaveBeenCalledWith('user-1', stateFromCookie)
  })
})

// ─── callback ────────────────────────────────────────────────────────────────

describe('GET /api/me/google/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    mockPrisma.googleCredential.findFirst.mockResolvedValue(null)
    mockPrisma.googleCredential.upsert.mockResolvedValue({})
  })

  it('400 STATE_MISMATCH when no cookie is present', async () => {
    const { GET } = await import('../../src/app/api/me/google/callback/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/callback?code=abc&state=xyz'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('STATE_MISMATCH')
    expect(mockExchangeCode).not.toHaveBeenCalled()
  })

  it('400 STATE_MISMATCH when cookie state differs from query state', async () => {
    const { GET } = await import('../../src/app/api/me/google/callback/route')
    const res = await GET(
      makeRequest('http://localhost/api/me/google/callback?code=abc&state=s2', {
        cookies: { google_oauth_state: 's1' },
      })
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('STATE_MISMATCH')
    expect(mockExchangeCode).not.toHaveBeenCalled()
  })

  it('happy path: row created, 302 to /settings/integrations?connected=1, cookie cleared', async () => {
    const result = makeExchangeResult()
    mockExchangeCode.mockResolvedValue(result)

    const { GET } = await import('../../src/app/api/me/google/callback/route')
    const res = await GET(
      makeRequest('http://localhost/api/me/google/callback?code=abc&state=match-state', {
        cookies: { google_oauth_state: 'match-state' },
      })
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('/settings/integrations?connected=1')

    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('google_oauth_state=')
    expect(setCookie).toContain('Max-Age=0')

    expect(mockPrisma.googleCredential.upsert).toHaveBeenCalledOnce()
    const upsertCall = mockPrisma.googleCredential.upsert.mock.calls[0][0]
    const encrypted = upsertCall.create.refreshTokenEncrypted
    expect(decryptSecret(encrypted)).toBe('refresh-token-abc')
  })

  it('400 INSUFFICIENT_SCOPES when exchangeCode throws InsufficientScopesError, no row created', async () => {
    const { InsufficientScopesError } = await import('../../src/lib/google/errors')
    mockExchangeCode.mockRejectedValue(
      new InsufficientScopesError(['https://www.googleapis.com/auth/documents.readonly'])
    )

    const { GET } = await import('../../src/app/api/me/google/callback/route')
    const res = await GET(
      makeRequest('http://localhost/api/me/google/callback?code=abc&state=match', {
        cookies: { google_oauth_state: 'match' },
      })
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('INSUFFICIENT_SCOPES')
    expect(body.missing).toContain('https://www.googleapis.com/auth/documents.readonly')
    expect(mockPrisma.googleCredential.upsert).not.toHaveBeenCalled()
  })

  it('502 OAUTH_EXCHANGE_FAILED when exchangeCode throws generic error', async () => {
    mockExchangeCode.mockRejectedValue(new Error('network failure'))

    const { GET } = await import('../../src/app/api/me/google/callback/route')
    const res = await GET(
      makeRequest('http://localhost/api/me/google/callback?code=abc&state=match', {
        cookies: { google_oauth_state: 'match' },
      })
    )

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('OAUTH_EXCHANGE_FAILED')
  })

  it('upsert replaces existing row for same userId', async () => {
    const first = makeExchangeResult({ refreshToken: 'first-refresh' })
    mockExchangeCode.mockResolvedValue(first)

    const { GET } = await import('../../src/app/api/me/google/callback/route')
    await GET(
      makeRequest('http://localhost/api/me/google/callback?code=abc&state=s', {
        cookies: { google_oauth_state: 's' },
      })
    )

    const second = makeExchangeResult({ refreshToken: 'second-refresh' })
    mockExchangeCode.mockResolvedValue(second)
    mockPrisma.googleCredential.upsert.mockClear()

    await GET(
      makeRequest('http://localhost/api/me/google/callback?code=abc&state=s', {
        cookies: { google_oauth_state: 's' },
      })
    )

    expect(mockPrisma.googleCredential.upsert).toHaveBeenCalledOnce()
    const call = mockPrisma.googleCredential.upsert.mock.calls[0][0]
    expect(decryptSecret(call.update.refreshTokenEncrypted)).toBe('second-refresh')
  })

  it('409 GOOGLE_ACCOUNT_BOUND_TO_OTHER_USER when same googleSub already belongs to different userId', async () => {
    const result = makeExchangeResult({ sub: 'google-sub-taken' })
    mockExchangeCode.mockResolvedValue(result)
    mockPrisma.googleCredential.findFirst.mockResolvedValue({
      userId: 'user-other',
      googleSub: 'google-sub-taken',
    })

    const { GET } = await import('../../src/app/api/me/google/callback/route')
    const res = await GET(
      makeRequest('http://localhost/api/me/google/callback?code=abc&state=s', {
        cookies: { google_oauth_state: 's' },
      })
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('GOOGLE_ACCOUNT_BOUND_TO_OTHER_USER')
    expect(mockPrisma.googleCredential.upsert).not.toHaveBeenCalled()
  })
})

// ─── disconnect ──────────────────────────────────────────────────────────────

describe('DELETE /api/me/google/disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
  })

  it('returns 401 when unauthenticated', async () => {
    mockSession.userId = ''
    const { DELETE } = await import('../../src/app/api/me/google/disconnect/route')
    const res = await DELETE(makeRequest('http://localhost/api/me/google/disconnect', { method: 'DELETE' }))
    expect(res.status).toBe(401)
  })

  it('204 and revokes + deletes row when credential exists', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      refreshTokenEncrypted: 'enc',
    })
    mockPrisma.googleCredential.delete.mockResolvedValue({})
    mockRevokeRefreshToken.mockResolvedValue(undefined)

    const { DELETE } = await import('../../src/app/api/me/google/disconnect/route')
    const res = await DELETE(makeRequest('http://localhost/api/me/google/disconnect', { method: 'DELETE' }))

    expect(res.status).toBe(204)
    expect(mockRevokeRefreshToken).toHaveBeenCalledWith('user-1')
    expect(mockPrisma.googleCredential.delete).toHaveBeenCalledWith({ where: { userId: 'user-1' } })
  })

  it('204 idempotent when no credential row exists', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(null)

    const { DELETE } = await import('../../src/app/api/me/google/disconnect/route')
    const res = await DELETE(makeRequest('http://localhost/api/me/google/disconnect', { method: 'DELETE' }))

    expect(res.status).toBe(204)
    expect(mockRevokeRefreshToken).not.toHaveBeenCalled()
    expect(mockPrisma.googleCredential.delete).not.toHaveBeenCalled()
  })

  it('204 and deletes row even when revokeRefreshToken rejects with network error', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      refreshTokenEncrypted: 'enc',
    })
    mockPrisma.googleCredential.delete.mockResolvedValue({})
    mockRevokeRefreshToken.mockRejectedValue(new Error('network error'))

    const { DELETE } = await import('../../src/app/api/me/google/disconnect/route')
    const res = await DELETE(makeRequest('http://localhost/api/me/google/disconnect', { method: 'DELETE' }))

    expect(res.status).toBe(204)
    expect(mockPrisma.googleCredential.delete).toHaveBeenCalledOnce()
  })
})

// ─── status ──────────────────────────────────────────────────────────────────

describe('GET /api/me/google/status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
  })

  it('returns 401 when unauthenticated', async () => {
    mockSession.userId = ''
    const { GET } = await import('../../src/app/api/me/google/status/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/status'))
    expect(res.status).toBe(401)
  })

  it('{ connected: false } when no row', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(null)

    const { GET } = await import('../../src/app/api/me/google/status/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/status'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ connected: false })
  })

  it('connected: true with correct fields for valid credential', async () => {
    const lastUsedAt = new Date('2026-01-15T10:00:00.000Z')
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      accessToken: 'access-token',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleEmail: 'user@example.com',
      googleSub: 'sub-1',
      scopes: REQUIRED_SCOPES.join(' '),
      lastUsedAt,
    })

    const { GET } = await import('../../src/app/api/me/google/status/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/status'))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.connected).toBe(true)
    expect(body.email).toBe('user@example.com')
    expect(body.scopes).toEqual(REQUIRED_SCOPES)
    expect(body.lastUsedAt).toBe('2026-01-15T10:00:00.000Z')
    expect(body.expired).toBe(false)
  })

  it('expired: true when accessToken and accessTokenExpiresAt are both null', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      accessToken: null,
      accessTokenExpiresAt: null,
      googleEmail: 'user@example.com',
      googleSub: 'sub-1',
      scopes: REQUIRED_SCOPES.join(' '),
      lastUsedAt: null,
    })

    const { GET } = await import('../../src/app/api/me/google/status/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/status'))
    const body = await res.json()

    expect(body.connected).toBe(true)
    expect(body.expired).toBe(true)
  })

  it('scopes are parsed correctly from space-separated string', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      accessToken: 'tok',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleEmail: 'user@example.com',
      googleSub: 'sub-1',
      scopes: 'scope-a scope-b scope-c',
      lastUsedAt: null,
    })

    const { GET } = await import('../../src/app/api/me/google/status/route')
    const res = await GET(makeRequest('http://localhost/api/me/google/status'))
    const body = await res.json()

    expect(body.scopes).toEqual(['scope-a', 'scope-b', 'scope-c'])
  })
})
