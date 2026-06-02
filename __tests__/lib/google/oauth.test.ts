import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock prisma ──────────────────────────────────────────────────────────────
vi.mock('../../../src/lib/db', () => {
  const findUnique = vi.fn()
  const update = vi.fn()
  return { prisma: { googleCredential: { findUnique, update } }, default: { googleCredential: { findUnique, update } } }
})

// ─── Mock secrets ─────────────────────────────────────────────────────────────
vi.mock('../../../src/lib/secrets', () => ({
  encryptSecret: vi.fn((s: string) => `enc:${s}`),
  decryptSecret: vi.fn((s: string) => {
    if (s.startsWith('enc:')) return s.slice(4)
    throw new Error('bad ciphertext')
  }),
  maskApiKey: vi.fn(),
}))

import { prisma } from '../../../src/lib/db'
import { encryptSecret, decryptSecret } from '../../../src/lib/secrets'
import {
  buildConsentUrl,
  exchangeCode,
  refreshAccessToken,
  revokeRefreshToken,
  ensureFreshAccessToken,
  REQUIRED_SCOPES,
} from '../../../src/lib/google/oauth'
import { __setGoogleFetchForTests } from '../../../src/lib/google/fetch'
import { GoogleAuthExpiredError, GoogleHttpError, InsufficientScopesError, TokenRevokedError } from '../../../src/lib/google/errors'

const mockPrisma = prisma as unknown as {
  googleCredential: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}
const mockEncrypt = encryptSecret as ReturnType<typeof vi.fn>
const mockDecrypt = decryptSecret as ReturnType<typeof vi.fn>

const ALL_SCOPES = REQUIRED_SCOPES.join(' ')

function makeFetch(responses: Array<{ status: number; ok: boolean; body: unknown }>) {
  let callIndex = 0
  return vi.fn(async () => {
    const r = responses[callIndex++]
    const bodyStr = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return {
      status: r.status,
      ok: r.ok,
      text: async () => bodyStr,
      json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
    }
  })
}

const TOKEN_RESPONSE = {
  access_token: 'fresh-access-token',
  refresh_token: 'refresh-token-123',
  expires_in: 3600,
  scope: ALL_SCOPES,
}

const USERINFO_RESPONSE = {
  email: 'user@example.com',
  sub: 'google-sub-123',
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/me/google/callback'
  process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64)
  delete process.env.GOOGLE_SCOPES_OVERRIDE
})

afterEach(() => {
  __setGoogleFetchForTests(null)
  delete process.env.GOOGLE_OAUTH_CLIENT_ID
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
  delete process.env.GOOGLE_OAUTH_REDIRECT_URI
  delete process.env.SETTINGS_ENCRYPTION_KEY
  delete process.env.GOOGLE_SCOPES_OVERRIDE
})

// ─── buildConsentUrl ──────────────────────────────────────────────────────────

describe('buildConsentUrl', () => {
  it('returns URL starting with Google auth endpoint', () => {
    const url = buildConsentUrl('user-1', 'my-state')
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
  })

  it('includes required fixed params', () => {
    const url = buildConsentUrl('user-1', 'my-state')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('access_type')).toBe('offline')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('include_granted_scopes')).toBe('true')
  })

  it('includes client_id and redirect_uri from env', () => {
    const url = buildConsentUrl('user-1', 'my-state')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id')
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/me/google/callback')
  })

  it('includes all four REQUIRED_SCOPES', () => {
    const url = buildConsentUrl('user-1', 'my-state')
    const parsed = new URL(url)
    const scope = parsed.searchParams.get('scope') ?? ''
    for (const s of REQUIRED_SCOPES) {
      expect(scope).toContain(s)
    }
  })

  it('passes state param unmodified', () => {
    const url = buildConsentUrl('user-1', 'abc-xyz-123')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('state')).toBe('abc-xyz-123')
  })

  it('uses GOOGLE_SCOPES_OVERRIDE when set', () => {
    process.env.GOOGLE_SCOPES_OVERRIDE = 'scope-a scope-b'
    const url = buildConsentUrl('user-1', 'my-state')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('scope')).toBe('scope-a scope-b')
  })
})

// ─── exchangeCode ─────────────────────────────────────────────────────────────

describe('exchangeCode', () => {
  it('happy path returns fully populated ExchangeResult', async () => {
    __setGoogleFetchForTests(
      makeFetch([
        { status: 200, ok: true, body: TOKEN_RESPONSE },
        { status: 200, ok: true, body: USERINFO_RESPONSE },
      ]),
    )

    const result = await exchangeCode('auth-code-123')

    expect(result.accessToken).toBe('fresh-access-token')
    expect(result.refreshToken).toBe('refresh-token-123')
    expect(result.email).toBe('user@example.com')
    expect(result.sub).toBe('google-sub-123')
    expect(result.scopes).toEqual(ALL_SCOPES.split(' '))
  })

  it('returns expiresAt ~now+3600s (AC-1)', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    __setGoogleFetchForTests(
      makeFetch([
        { status: 200, ok: true, body: TOKEN_RESPONSE },
        { status: 200, ok: true, body: USERINFO_RESPONSE },
      ]),
    )

    const result = await exchangeCode('auth-code-123')
    const diff = result.expiresAt.getTime() - now
    expect(diff).toBeGreaterThanOrEqual(3599 * 1000)
    expect(diff).toBeLessThanOrEqual(3601 * 1000)

    vi.useRealTimers()
  })

  it('throws GoogleHttpError when token endpoint returns 400 (AC-1)', async () => {
    __setGoogleFetchForTests(
      makeFetch([
        { status: 400, ok: false, body: '{"error":"invalid_client"}' },
      ]),
    )

    await expect(exchangeCode('bad-code')).rejects.toBeInstanceOf(GoogleHttpError)
  })

  it('AC-14: throws InsufficientScopesError when scope missing documents.readonly; no userinfo call', async () => {
    const limitedScopes = REQUIRED_SCOPES.filter((s) => !s.includes('documents')).join(' ')
    const mockFn = makeFetch([
      {
        status: 200,
        ok: true,
        body: { ...TOKEN_RESPONSE, scope: limitedScopes },
      },
    ])
    __setGoogleFetchForTests(mockFn)

    const err = await exchangeCode('code').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InsufficientScopesError)
    expect((err as InsufficientScopesError).missing).toEqual([
      'https://www.googleapis.com/auth/documents.readonly',
    ])
    // only one fetch call (token); userinfo not called
    expect(mockFn).toHaveBeenCalledTimes(1)
  })
})

// ─── refreshAccessToken ───────────────────────────────────────────────────────

describe('refreshAccessToken', () => {
  const storedCred = {
    userId: 'user-1',
    refreshTokenEncrypted: 'enc:stored-refresh-token',
    accessToken: 'old-access',
    accessTokenExpiresAt: new Date(Date.now() - 1000),
  }

  it('AC-3: returns new accessToken and updates row', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(storedCred)
    mockPrisma.googleCredential.update.mockResolvedValue({})

    __setGoogleFetchForTests(
      makeFetch([{ status: 200, ok: true, body: TOKEN_RESPONSE }]),
    )

    const token = await refreshAccessToken('user-1')

    // Returned token is the live plaintext value for immediate use…
    expect(token).toBe('fresh-access-token')
    // …but it is encrypted at rest before being persisted (mirrors refresh token).
    expect(mockEncrypt).toHaveBeenCalledWith('fresh-access-token')
    expect(mockPrisma.googleCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        data: expect.objectContaining({
          accessToken: 'enc:fresh-access-token',
          lastUsedAt: expect.any(Date),
        }),
      }),
    )
  })

  it('AC-15: persists rotated refresh token when response includes new refresh_token', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(storedCred)
    mockPrisma.googleCredential.update.mockResolvedValue({})

    const newRefreshToken = 'brand-new-refresh-token'
    __setGoogleFetchForTests(
      makeFetch([
        { status: 200, ok: true, body: { ...TOKEN_RESPONSE, refresh_token: newRefreshToken } },
      ]),
    )

    await refreshAccessToken('user-1')

    expect(mockEncrypt).toHaveBeenCalledWith(newRefreshToken)
    const updateCall = mockPrisma.googleCredential.update.mock.calls[0][0]
    expect(updateCall.data.refreshTokenEncrypted).toBe(`enc:${newRefreshToken}`)
  })

  it('AC-16/E2: 400+invalid_grant throws TokenRevokedError; row wiped but kept', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(storedCred)
    mockPrisma.googleCredential.update.mockResolvedValue({})

    __setGoogleFetchForTests(
      makeFetch([{ status: 400, ok: false, body: { error: 'invalid_grant' } }]),
    )

    await expect(refreshAccessToken('user-1')).rejects.toBeInstanceOf(TokenRevokedError)

    expect(mockPrisma.googleCredential.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { accessToken: null, accessTokenExpiresAt: null },
    })
  })

  it('throws GoogleAuthExpiredError when row is missing', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(null)

    await expect(refreshAccessToken('user-1')).rejects.toBeInstanceOf(GoogleAuthExpiredError)
  })

  it('decrypts the stored refresh token before sending', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(storedCred)
    mockPrisma.googleCredential.update.mockResolvedValue({})

    __setGoogleFetchForTests(
      makeFetch([{ status: 200, ok: true, body: TOKEN_RESPONSE }]),
    )

    await refreshAccessToken('user-1')

    expect(mockDecrypt).toHaveBeenCalledWith('enc:stored-refresh-token')
  })
})

// ─── ensureFreshAccessToken (E15) ─────────────────────────────────────────────

describe('ensureFreshAccessToken', () => {
  it('decrypts the encrypted access token at rest before returning it (no fetch)', async () => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      accessToken: 'enc:valid-access-token', // stored encrypted (mock: enc:<plaintext>)
      accessTokenExpiresAt: expiresAt,
      refreshTokenEncrypted: 'enc:refresh',
    })

    const mockFn = makeFetch([])
    __setGoogleFetchForTests(mockFn)

    const token = await ensureFreshAccessToken('user-1')

    expect(token).toBe('valid-access-token') // decrypted
    expect(mockDecrypt).toHaveBeenCalledWith('enc:valid-access-token')
    expect(mockFn).not.toHaveBeenCalled()
  })

  it('tolerates a legacy plaintext access token (decrypt fails → returned as-is)', async () => {
    // Rows written before encryption-at-rest hold plaintext. The mock decrypt
    // throws on non-"enc:" values, exactly like GCM auth failure on plaintext.
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      accessToken: 'legacy-plaintext-token',
      accessTokenExpiresAt: expiresAt,
      refreshTokenEncrypted: 'enc:refresh',
    })

    const mockFn = makeFetch([])
    __setGoogleFetchForTests(mockFn)

    const token = await ensureFreshAccessToken('user-1')

    expect(token).toBe('legacy-plaintext-token') // fallback, no crash
    expect(mockFn).not.toHaveBeenCalled()
  })

  it('triggers refresh when token expires in 10 seconds', async () => {
    const expiresAt = new Date(Date.now() + 10 * 1000)
    mockPrisma.googleCredential.findUnique
      .mockResolvedValueOnce({
        userId: 'user-1',
        accessToken: 'expiring-token',
        accessTokenExpiresAt: expiresAt,
        refreshTokenEncrypted: 'enc:refresh',
      })
      .mockResolvedValueOnce({
        userId: 'user-1',
        accessToken: 'expiring-token',
        accessTokenExpiresAt: expiresAt,
        refreshTokenEncrypted: 'enc:refresh',
      })
    mockPrisma.googleCredential.update.mockResolvedValue({})

    __setGoogleFetchForTests(
      makeFetch([{ status: 200, ok: true, body: TOKEN_RESPONSE }]),
    )

    const token = await ensureFreshAccessToken('user-1')

    expect(token).toBe('fresh-access-token')
  })

  it('triggers refresh when accessToken is null', async () => {
    mockPrisma.googleCredential.findUnique
      .mockResolvedValueOnce({
        userId: 'user-1',
        accessToken: null,
        accessTokenExpiresAt: null,
        refreshTokenEncrypted: 'enc:refresh',
      })
      .mockResolvedValueOnce({
        userId: 'user-1',
        accessToken: null,
        accessTokenExpiresAt: null,
        refreshTokenEncrypted: 'enc:refresh',
      })
    mockPrisma.googleCredential.update.mockResolvedValue({})

    __setGoogleFetchForTests(
      makeFetch([{ status: 200, ok: true, body: TOKEN_RESPONSE }]),
    )

    const token = await ensureFreshAccessToken('user-1')

    expect(token).toBe('fresh-access-token')
  })
})

// ─── revokeRefreshToken ───────────────────────────────────────────────────────

describe('revokeRefreshToken', () => {
  const storedCred = {
    userId: 'user-1',
    refreshTokenEncrypted: 'enc:stored-refresh-token',
  }

  it('resolves on 200', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(storedCred)
    __setGoogleFetchForTests(makeFetch([{ status: 200, ok: true, body: '' }]))

    await expect(revokeRefreshToken('user-1')).resolves.toBeUndefined()
  })

  it('resolves on 400 (best-effort — Google returns 400 for already-invalid tokens)', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(storedCred)
    __setGoogleFetchForTests(makeFetch([{ status: 400, ok: false, body: '{"error":"invalid_token"}' }]))

    await expect(revokeRefreshToken('user-1')).resolves.toBeUndefined()
  })

  it('resolves without rethrowing when fetch throws (best-effort)', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(storedCred)
    __setGoogleFetchForTests(vi.fn().mockRejectedValue(new Error('Network error')))

    await expect(revokeRefreshToken('user-1')).resolves.toBeUndefined()
  })
})

// ─── No-leak guarantee (AC-19) ────────────────────────────────────────────────

describe('AC-19: no sensitive values logged', () => {
  it('exchange + refresh + revoke do not log plaintext tokens or client secret', async () => {
    const REFRESH_TOKEN = 'super-secret-refresh-token-do-not-log'
    const ACCESS_TOKEN = 'super-secret-access-token-do-not-log'
    const CLIENT_SECRET = 'test-client-secret'

    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const tokenResp = {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: 3600,
      scope: ALL_SCOPES,
    }

    // exchangeCode
    __setGoogleFetchForTests(
      makeFetch([
        { status: 200, ok: true, body: tokenResp },
        { status: 200, ok: true, body: USERINFO_RESPONSE },
      ]),
    )
    await exchangeCode('auth-code').catch(() => undefined)

    // refreshAccessToken
    __setGoogleFetchForTests(null)
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      userId: 'user-1',
      refreshTokenEncrypted: `enc:${REFRESH_TOKEN}`,
    })
    mockPrisma.googleCredential.update.mockResolvedValue({})
    __setGoogleFetchForTests(makeFetch([{ status: 200, ok: true, body: tokenResp }]))
    await refreshAccessToken('user-1').catch(() => undefined)

    // revokeRefreshToken
    __setGoogleFetchForTests(null)
    __setGoogleFetchForTests(makeFetch([{ status: 200, ok: true, body: '' }]))
    await revokeRefreshToken('user-1').catch(() => undefined)

    const allLogArgs = [
      ...spyLog.mock.calls,
      ...spyWarn.mock.calls,
      ...spyError.mock.calls,
    ]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')

    expect(allLogArgs).not.toContain(REFRESH_TOKEN)
    expect(allLogArgs).not.toContain(ACCESS_TOKEN)
    expect(allLogArgs).not.toContain(CLIENT_SECRET)

    spyLog.mockRestore()
    spyWarn.mockRestore()
    spyError.mockRestore()
  })
})
