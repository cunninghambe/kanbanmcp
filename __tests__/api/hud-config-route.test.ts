/**
 * Tests for GET /api/hud/config — surfaces enabled dispatch targets to the client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

const mockPrisma = { orgMember: { findUnique: vi.fn() } }
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

async function callGet() {
  const { GET } = await import('../../src/app/api/hud/config/route')
  return GET(new NextRequest('http://localhost/api/hud/config'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/hud/config', () => {
  it('returns all four targets by default', async () => {
    const res = await callGet()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect([...body.enabledTargets].sort()).toEqual(['board', 'drive', 'email', 'slack'])
  })

  it('honors HUD_ENABLED_TARGETS', async () => {
    vi.stubEnv('HUD_ENABLED_TARGETS', 'board,drive')
    const res = await callGet()
    const body = await res.json()
    expect(body.enabledTargets).toEqual(['board', 'drive'])
  })

  it('rejects a request from a non-member', async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue(null)
    const res = await callGet()
    expect(res.status).toBe(403)
  })
})
