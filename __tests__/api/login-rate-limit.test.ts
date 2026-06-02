/**
 * Tests for the rate-limit IP derivation on POST /api/auth/login.
 *
 * SECURITY FOCUS: the limiter must key on the IP appended by our trusted
 * reverse proxy (the LAST hop of X-Forwarded-For by default), NOT the
 * client-controlled leftmost value. Otherwise an attacker rotates XFF to
 * bypass throttling.
 *
 * We mock checkRateLimit so we can both (a) inspect the key it is called with
 * and (b) force a 429 to assert the route surfaces it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session + next/headers ───────────────────────────────────────
const mockSession = {
  userId: '',
  orgId: '',
  save: vi.fn().mockResolvedValue(undefined),
}
vi.mock('iron-session', () => ({
  getIronSession: vi.fn().mockResolvedValue(mockSession),
}))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

// ─── Mock prisma ────────────────────────────────────────────────────────────
const mockPrisma = {
  user: { findUnique: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

// ─── Mock rate-limit so we can observe keys and control the verdict ─────────
const mockCheckRateLimit = vi.fn()
vi.mock('../../src/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'user@example.com', password: 'password123' }),
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('POST /api/auth/login rate-limit IP derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.PLAYWRIGHT_E2E
    delete process.env.TRUSTED_PROXY_HOPS
    mockSession.userId = ''
    mockSession.orgId = ''
    // Default: allow through so we can inspect the derived key. User lookup
    // returns null so the route short-circuits to 401 after the limiter.
    mockCheckRateLimit.mockReturnValue(true)
    mockPrisma.user.findUnique.mockResolvedValue(null)
  })

  // ─── Negative / false-positive boundary: spoofed leftmost XFF must NOT ──────
  // ─── create distinct limiter keys when the trusted last hop is the same. ────
  it('keys on the trusted last hop, so two spoofed leftmost IPs share one key', async () => {
    const { POST } = await import('../../src/app/api/auth/login/route')

    // Attacker rotates the leftmost (client-supplied) entry, but our nginx
    // appends the same real client IP as the last hop both times.
    await POST(makeRequest({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }))
    await POST(makeRequest({ 'x-forwarded-for': '2.2.2.2, 9.9.9.9' }))

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2)
    const firstKey = mockCheckRateLimit.mock.calls[0][0]
    const secondKey = mockCheckRateLimit.mock.calls[1][0]
    // Both requests counted together — the spoofed leftmost is ignored.
    expect(firstKey).toBe('login:9.9.9.9')
    expect(secondKey).toBe('login:9.9.9.9')
    expect(firstKey).toBe(secondKey)
  })

  // ─── Positive: when the limiter says no, the route returns 429 ──────────────
  it('returns 429 when the limiter is exceeded', async () => {
    mockCheckRateLimit.mockReturnValue(false)
    const { POST } = await import('../../src/app/api/auth/login/route')
    const res = await POST(makeRequest({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toMatch(/too many login attempts/i)
    // No DB lookup should happen once rate-limited.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
  })

  // ─── Edge case: single-hop XFF (only the real client IP present) ────────────
  it('keys on the only XFF entry when there is a single hop', async () => {
    const { POST } = await import('../../src/app/api/auth/login/route')
    await POST(makeRequest({ 'x-forwarded-for': '203.0.113.7' }))
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('login:203.0.113.7')
  })

  // ─── Edge case: TRUSTED_PROXY_HOPS honored (2 proxies → second-from-right) ──
  it('honors TRUSTED_PROXY_HOPS when picking the trusted hop', async () => {
    process.env.TRUSTED_PROXY_HOPS = '2'
    const { POST } = await import('../../src/app/api/auth/login/route')
    // chain: client, realClient, nginx-edge. With 2 trusted hops, the trusted
    // client IP is index (3 - 2) = 1 → 'realclient'.
    await POST(
      makeRequest({ 'x-forwarded-for': 'spoofed, realclient, nginx-edge' })
    )
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('login:realclient')
  })

  // ─── Edge case: falls back to x-real-ip then 'unknown' ──────────────────────
  it('falls back to x-real-ip when no XFF header is present', async () => {
    const { POST } = await import('../../src/app/api/auth/login/route')
    await POST(makeRequest({ 'x-real-ip': '198.51.100.4' }))
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('login:198.51.100.4')
  })

  it('falls back to "unknown" when no IP headers are present', async () => {
    const { POST } = await import('../../src/app/api/auth/login/route')
    await POST(makeRequest({}))
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('login:unknown')
  })

  // ─── Edge case: PLAYWRIGHT_E2E skips the limiter entirely ───────────────────
  it('does not call the limiter under PLAYWRIGHT_E2E', async () => {
    process.env.PLAYWRIGHT_E2E = '1'
    const { POST } = await import('../../src/app/api/auth/login/route')
    await POST(makeRequest({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }))
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
  })
})
