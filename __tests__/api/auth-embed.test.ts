/**
 * Tests for POST /api/auth/embed
 *
 * Covers the hardening fixes:
 *  - token comes from Authorization header or POST body, NOT a GET query param
 *  - the minted session is a deterministic, low-privilege (non-ADMIN) member
 *  - cookies() is awaited (no un-awaited Promise passed to getIronSession)
 *  - errors return a generic 500 rather than throwing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createHash } from 'crypto'

// ─── Mock iron-session ────────────────────────────────────────────────────────
const mockSession: {
  userId: string
  orgId: string
  isApiKeyAuth?: boolean
  agentName?: string
  save: ReturnType<typeof vi.fn>
} = { userId: '', orgId: '', save: vi.fn() }

const mockGetIronSession = vi.fn().mockResolvedValue(mockSession)
vi.mock('iron-session', () => ({ getIronSession: (...args: unknown[]) => mockGetIronSession(...args) }))

// cookies() MUST be awaitable — the route does `await cookies()`. Return a Promise.
const mockCookieStore = {}
vi.mock('next/headers', () => ({ cookies: vi.fn().mockResolvedValue(mockCookieStore) }))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  apiKey: { findUnique: vi.fn(), update: vi.fn() },
  orgMember: { findMany: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

const ORG_ID = 'org-1'
const RAW_TOKEN = 'embed-token-secret'
const KEY_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex')

const apiKeyRow = {
  id: 'key-1',
  orgId: ORG_ID,
  name: 'embed',
  keyHash: KEY_HASH,
  agentName: 'paperclip-embed',
  permissions: '[]',
  lastUsedAt: null,
  createdAt: new Date(),
}

async function getPOST() {
  const mod = await import('../../src/app/api/auth/embed/route')
  return mod.POST as typeof mod.POST
}

describe('POST /api/auth/embed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = ''
    mockSession.orgId = ''
    mockSession.isApiKeyAuth = undefined
    mockSession.agentName = undefined
    mockGetIronSession.mockResolvedValue(mockSession)
    mockPrisma.apiKey.findUnique.mockResolvedValue(apiKeyRow)
    mockPrisma.apiKey.update.mockResolvedValue({})
    // Deterministic membership: ADMIN sorts before MEMBER by userId, so the
    // route must still pick the non-ADMIN despite ordering.
    mockPrisma.orgMember.findMany.mockResolvedValue([
      { userId: 'admin-user', orgId: ORG_ID, role: 'ADMIN' },
      { userId: 'member-user', orgId: ORG_ID, role: 'MEMBER' },
    ])
  })

  it('authenticates via Authorization: Bearer header and returns the redirect', async () => {
    const req = new NextRequest('http://localhost/api/auth/embed', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    })
    const POST = await getPOST()
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.redirect).toBe('/dashboard')
    expect(mockSession.save).toHaveBeenCalled()
  })

  it('authenticates via the POST JSON body token', async () => {
    const req = new NextRequest('http://localhost/api/auth/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: RAW_TOKEN }),
    })
    const POST = await getPOST()
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockSession.save).toHaveBeenCalled()
  })

  it('mints a NON-ADMIN session even though ADMIN sorts first', async () => {
    const req = new NextRequest('http://localhost/api/auth/embed', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    })
    const POST = await getPOST()
    await POST(req)
    expect(mockSession.userId).toBe('member-user')
    expect(mockSession.orgId).toBe(ORG_ID)
  })

  it('does NOT authenticate from a query-string token (legacy GET path removed)', async () => {
    // Token only present as a query param; no header, no body token.
    const req = new NextRequest(`http://localhost/api/auth/embed?token=${RAW_TOKEN}`, {
      method: 'POST',
    })
    const POST = await getPOST()
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Missing embed token')
    // No session should have been minted.
    expect(mockSession.save).not.toHaveBeenCalled()
    expect(mockPrisma.apiKey.findUnique).not.toHaveBeenCalled()
  })

  it('falls back to the only member when no non-admin exists (edge case)', async () => {
    mockPrisma.orgMember.findMany.mockResolvedValue([
      { userId: 'solo-admin', orgId: ORG_ID, role: 'ADMIN' },
    ])
    const req = new NextRequest('http://localhost/api/auth/embed', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    })
    const POST = await getPOST()
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockSession.userId).toBe('solo-admin')
  })

  it('returns 401 for an invalid token', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/auth/embed', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    })
    const POST = await getPOST()
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect(mockSession.save).not.toHaveBeenCalled()
  })

  it('returns 500 when the org has no members (edge case)', async () => {
    mockPrisma.orgMember.findMany.mockResolvedValue([])
    const req = new NextRequest('http://localhost/api/auth/embed', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    })
    const POST = await getPOST()
    const res = await POST(req)
    expect(res.status).toBe(500)
    expect(mockSession.save).not.toHaveBeenCalled()
  })

  it('awaits cookies() — passes a resolved store (not a Promise) to getIronSession', async () => {
    const req = new NextRequest('http://localhost/api/auth/embed', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    })
    const POST = await getPOST()
    await POST(req)
    expect(mockGetIronSession).toHaveBeenCalled()
    const firstArg = mockGetIronSession.mock.calls[0][0]
    // The awaited cookie store must be the resolved object, not a thenable.
    expect(firstArg).toBe(mockCookieStore)
    expect(typeof (firstArg as { then?: unknown }).then).not.toBe('function')
  })

  it('sets a short cookie maxAge in the session options', async () => {
    const req = new NextRequest('http://localhost/api/auth/embed', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    })
    const POST = await getPOST()
    await POST(req)
    const optionsArg = mockGetIronSession.mock.calls[0][1] as {
      cookieOptions?: { maxAge?: number }
    }
    expect(optionsArg.cookieOptions?.maxAge).toBeGreaterThan(0)
    // Should be a short-lived session (<= 1 hour), not an open-ended cookie.
    expect(optionsArg.cookieOptions?.maxAge).toBeLessThanOrEqual(60 * 60)
  })
})
