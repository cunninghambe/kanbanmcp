/**
 * Tests for POST /api/hud/[id]/dispatch hardening:
 *   question length cap, per-session/per-org concurrency caps, target gating.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }

vi.mock('iron-session', () => ({
  getIronSession: vi.fn().mockResolvedValue(mockSession),
}))
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockReturnValue({}),
}))

const mockPrisma = {
  hudSession: { findFirst: vi.fn() },
  agentDispatch: { create: vi.fn(), count: vi.fn() },
  orgMember: { findUnique: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const enqueueDispatch = vi.fn()
vi.mock('../../src/lib/host-hud/worker', () => ({ enqueueDispatch: (id: string) => enqueueDispatch(id) }))

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/hud/hud-1/dispatch', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

async function callPost(body: unknown) {
  const { POST } = await import('../../src/app/api/hud/[id]/dispatch/route')
  return POST(makeRequest(body), { params: Promise.resolve({ id: 'hud-1' }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  mockPrisma.hudSession.findFirst.mockResolvedValue({ id: 'hud-1', status: 'live' })
  mockPrisma.agentDispatch.count.mockResolvedValue(0)
  mockPrisma.agentDispatch.create.mockResolvedValue({ id: 'disp-1' })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/hud/[id]/dispatch — question length', () => {
  it('accepts a question at exactly the max length', async () => {
    const res = await callPost({ target: 'board', question: 'a'.repeat(2000) })
    expect(res.status).toBe(201)
    expect(enqueueDispatch).toHaveBeenCalledWith('disp-1')
  })

  it('rejects a question over the max length with 400', async () => {
    const res = await callPost({ target: 'board', question: 'a'.repeat(2001) })
    expect(res.status).toBe(400)
    expect(mockPrisma.agentDispatch.create).not.toHaveBeenCalled()
  })
})

describe('POST /api/hud/[id]/dispatch — concurrency caps', () => {
  it('returns 429 when the per-session in-flight cap is reached', async () => {
    mockPrisma.agentDispatch.count.mockImplementation((args: { where: { hudSessionId?: string } }) =>
      Promise.resolve(args.where.hudSessionId ? 3 : 0)
    )
    const res = await callPost({ target: 'board', question: 'q' })
    expect(res.status).toBe(429)
    expect(mockPrisma.agentDispatch.create).not.toHaveBeenCalled()
  })

  it('returns 429 when the per-org in-flight cap is reached', async () => {
    mockPrisma.agentDispatch.count.mockImplementation((args: { where: { hudSessionId?: string } }) =>
      Promise.resolve(args.where.hudSessionId ? 0 : 8)
    )
    const res = await callPost({ target: 'board', question: 'q' })
    expect(res.status).toBe(429)
    expect(mockPrisma.agentDispatch.create).not.toHaveBeenCalled()
  })

  it('allows a dispatch while under both caps', async () => {
    mockPrisma.agentDispatch.count.mockResolvedValue(2)
    const res = await callPost({ target: 'board', question: 'q' })
    expect(res.status).toBe(201)
  })
})

describe('POST /api/hud/[id]/dispatch — target gating', () => {
  it('rejects a target disabled by HUD_ENABLED_TARGETS with 400', async () => {
    vi.stubEnv('HUD_ENABLED_TARGETS', 'board,drive')
    const res = await callPost({ target: 'slack', question: 'q' })
    expect(res.status).toBe(400)
    expect(mockPrisma.agentDispatch.create).not.toHaveBeenCalled()
  })

  it('allows an enabled target', async () => {
    vi.stubEnv('HUD_ENABLED_TARGETS', 'board,drive')
    const res = await callPost({ target: 'drive', question: 'q' })
    expect(res.status).toBe(201)
  })
})
