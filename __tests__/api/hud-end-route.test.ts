/**
 * Tests for POST /api/hud/[id]/end — ending a session cancels its in-flight
 * dispatches so their external ClaudeMCP jobs stop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

const mockPrisma = {
  hudSession: { findFirst: vi.fn(), update: vi.fn() },
  agentDispatch: { updateMany: vi.fn() },
  orgMember: { findUnique: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

async function callPost() {
  const { POST } = await import('../../src/app/api/hud/[id]/end/route')
  return POST(new NextRequest('http://localhost/api/hud/hud-1/end', { method: 'POST' }), {
    params: Promise.resolve({ id: 'hud-1' }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  mockPrisma.hudSession.findFirst.mockResolvedValue({ id: 'hud-1', status: 'live' })
  mockPrisma.hudSession.update.mockResolvedValue({ id: 'hud-1', status: 'ended' })
  mockPrisma.agentDispatch.updateMany.mockResolvedValue({ count: 2 })
})

describe('POST /api/hud/[id]/end', () => {
  it('ends the session and cancels its in-flight dispatches', async () => {
    const res = await callPost()
    expect(res.status).toBe(200)

    expect(mockPrisma.hudSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ended' }) })
    )
    expect(mockPrisma.agentDispatch.updateMany).toHaveBeenCalledTimes(1)
    const call = mockPrisma.agentDispatch.updateMany.mock.calls[0][0]
    expect(call.where).toEqual({ hudSessionId: 'hud-1', status: { in: ['queued', 'running'] } })
    expect(call.data.status).toBe('cancelled')
  })

  it('returns 404 when the session does not belong to the org', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue(null)
    const res = await callPost()
    expect(res.status).toBe(404)
    expect(mockPrisma.agentDispatch.updateMany).not.toHaveBeenCalled()
  })
})
