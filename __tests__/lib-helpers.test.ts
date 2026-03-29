/**
 * Tests for lib/api-helpers, lib/auth, lib/agent-auth, lib/agent-activity
 * All prisma imports are mocked to avoid "prisma generate" requirement.
 */
import { describe, it, expect, vi } from 'vitest'

// ─── Mock prisma (must be before any module that uses it) ────────────────────
vi.mock('../src/lib/db', () => ({
  prisma: {
    orgMember: { findUnique: vi.fn() },
  },
  default: {
    orgMember: { findUnique: vi.fn() },
  },
}))

// Also mock next/headers and iron-session to avoid missing-context errors
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))
vi.mock('iron-session', () => ({
  getIronSession: vi.fn().mockResolvedValue({ userId: '', orgId: '', save: vi.fn() }),
}))

// ─── api-helpers: paginationParams ───────────────────────────────────────────
describe('paginationParams', () => {
  it('returns defaults when no query params', async () => {
    const { paginationParams } = await import('../src/lib/api-helpers')
    const result = paginationParams('https://example.com/api/activity')
    expect(result).toEqual({ page: 1, limit: 20, skip: 0 })
  })

  it('parses explicit page and limit', async () => {
    const { paginationParams } = await import('../src/lib/api-helpers')
    const result = paginationParams('https://example.com/api/activity?page=3&limit=10')
    expect(result).toEqual({ page: 3, limit: 10, skip: 20 })
  })

  it('clamps limit to 100 max', async () => {
    const { paginationParams } = await import('../src/lib/api-helpers')
    const result = paginationParams('https://example.com/api/activity?limit=999')
    expect(result.limit).toBe(100)
  })

  it('falls back to defaults for invalid values', async () => {
    const { paginationParams } = await import('../src/lib/api-helpers')
    const result = paginationParams('https://example.com/api/activity?page=abc&limit=-5')
    expect(result).toEqual({ page: 1, limit: 20, skip: 0 })
  })

  it('falls back to defaults for page=0', async () => {
    const { paginationParams } = await import('../src/lib/api-helpers')
    const result = paginationParams('https://example.com/api/activity?page=0')
    expect(result.page).toBe(1)
  })

  it('computes skip correctly', async () => {
    const { paginationParams } = await import('../src/lib/api-helpers')
    const result = paginationParams('https://example.com/api/activity?page=5&limit=15')
    expect(result.skip).toBe(60) // (5-1) * 15
  })
})

// ─── api-helpers: apiError ────────────────────────────────────────────────────
describe('apiError', () => {
  it('returns NextResponse with correct status and JSON body', async () => {
    const { apiError } = await import('../src/lib/api-helpers')
    const res = apiError(404, 'Not found')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'Not found' })
  })

  it('works for 500 status', async () => {
    const { apiError } = await import('../src/lib/api-helpers')
    const res = apiError(500, 'Internal server error')
    expect(res.status).toBe(500)
  })
})

// ─── lib/auth: password hashing ──────────────────────────────────────────────
describe('auth helpers', () => {
  it('hashPassword produces a bcrypt hash', async () => {
    const { hashPassword } = await import('../src/lib/auth')
    const hash = await hashPassword('mypassword')
    expect(hash).toMatch(/^\$2[aby]\$/)
    expect(hash.length).toBeGreaterThan(40)
  })

  it('hashPassword different calls produce different hashes', async () => {
    const { hashPassword } = await import('../src/lib/auth')
    const h1 = await hashPassword('password123')
    const h2 = await hashPassword('password123')
    expect(h1).not.toBe(h2) // bcrypt uses random salt
  })

  it('verifyPassword returns true for correct password', async () => {
    const { hashPassword, verifyPassword } = await import('../src/lib/auth')
    const hash = await hashPassword('correcthorse')
    const valid = await verifyPassword('correcthorse', hash)
    expect(valid).toBe(true)
  })

  it('verifyPassword returns false for wrong password', async () => {
    const { hashPassword, verifyPassword } = await import('../src/lib/auth')
    const hash = await hashPassword('correcthorse')
    const valid = await verifyPassword('wrongpassword', hash)
    expect(valid).toBe(false)
  })

  it('verifyPassword handles empty password', async () => {
    const { hashPassword, verifyPassword } = await import('../src/lib/auth')
    const hash = await hashPassword('realpassword')
    const valid = await verifyPassword('', hash)
    expect(valid).toBe(false)
  })
})
