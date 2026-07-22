/**
 * Tests for GET /api/hud/metrics
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = vi.hoisted(() => ({
  agentDispatch: { findMany: vi.fn() },
  changeSet: { findMany: vi.fn() },
  changeItem: { findMany: vi.fn() },
}))
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

// ─── Mock api-helpers ─────────────────────────────────────────────────────────
const mockRequireSession = vi.fn()
const mockRequireOrgRole = vi.fn()
vi.mock('../../src/lib/api-helpers', () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
  requireOrgRole: (...args: unknown[]) => mockRequireOrgRole(...args),
  apiError: (status: number, msg: string) => {
    const { NextResponse } = require('next/server')
    return NextResponse.json({ error: msg }, { status })
  },
}))

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/hud/metrics', { method: 'GET' })
}

// Helper to build a Date offset by N ms from a fixed epoch (deterministic).
const BASE = new Date('2026-07-22T00:00:00.000Z').getTime()
const at = (ms: number) => new Date(BASE + ms)

describe('GET /api/hud/metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireSession.mockResolvedValue({ userId: 'user-1', orgId: 'org-1' })
    mockRequireOrgRole.mockResolvedValue({ role: 'MEMBER' })
  })

  it('returns 401 for anonymous requests', async () => {
    const { NextResponse } = await import('next/server')
    mockRequireSession.mockRejectedValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
    const { GET } = await import('../../src/app/api/hud/metrics/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    // prisma must not be touched when auth fails
    expect(mockPrisma.agentDispatch.findMany).not.toHaveBeenCalled()
  })

  it('computes counts, medians, and rates from a seeded fixture', async () => {
    // 3 done dispatches with latencies 1000, 2000, 3000 → median 2000
    // plus 1 each of failed / cancelled / running / queued → total 7
    mockPrisma.agentDispatch.findMany.mockResolvedValue([
      { status: 'done', startedAt: at(0), finishedAt: at(1000) },
      { status: 'done', startedAt: at(0), finishedAt: at(2000) },
      { status: 'done', startedAt: at(0), finishedAt: at(3000) },
      { status: 'failed', startedAt: at(0), finishedAt: null },
      { status: 'cancelled', startedAt: at(0), finishedAt: at(500) },
      { status: 'running', startedAt: at(0), finishedAt: null },
      { status: 'queued', startedAt: null, finishedAt: null },
    ])

    // proposed = pending(2) + partially_applied(1) = 3; applied = 2; expired = 1
    // applied review times: 5000, 15000 → median 10000
    mockPrisma.changeSet.findMany.mockResolvedValue([
      { status: 'pending', createdAt: at(0), appliedAt: null },
      { status: 'pending', createdAt: at(0), appliedAt: null },
      { status: 'partially_applied', createdAt: at(0), appliedAt: null },
      { status: 'applied', createdAt: at(0), appliedAt: at(5000) },
      { status: 'applied', createdAt: at(0), appliedAt: at(15000) },
      { status: 'expired', createdAt: at(0), appliedAt: null },
    ])

    // decided = approved(2) + rejected(1) + retargeted(1) = 4; 1 pending ignored
    // retargetRate = 1/4 = 0.25; rejectRate = 1/4 = 0.25
    mockPrisma.changeItem.findMany.mockResolvedValue([
      { decision: 'approved' },
      { decision: 'approved' },
      { decision: 'rejected' },
      { decision: 'retargeted' },
      { decision: 'pending' },
    ])

    const { GET } = await import('../../src/app/api/hud/metrics/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.dispatch).toEqual({
      total: 7,
      byStatus: { done: 3, failed: 1, cancelled: 1, running: 1, queued: 1 },
      medianLatencyMs: 2000,
    })
    expect(body.changeset).toEqual({
      proposed: 3,
      applied: 2,
      expired: 1,
      retargetRate: 0.25,
      rejectRate: 0.25,
      medianTimeToReviewMs: 10000,
    })

    // org-scoping: change items filtered via changeSet relation
    expect(mockPrisma.changeItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { changeSet: { orgId: 'org-1' } } })
    )
  })

  it('handles empty data without dividing by zero (rates 0, medians null)', async () => {
    mockPrisma.agentDispatch.findMany.mockResolvedValue([])
    mockPrisma.changeSet.findMany.mockResolvedValue([])
    mockPrisma.changeItem.findMany.mockResolvedValue([])

    const { GET } = await import('../../src/app/api/hud/metrics/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.dispatch).toEqual({
      total: 0,
      byStatus: { done: 0, failed: 0, cancelled: 0, running: 0, queued: 0 },
      medianLatencyMs: null,
    })
    expect(body.changeset).toEqual({
      proposed: 0,
      applied: 0,
      expired: 0,
      retargetRate: 0,
      rejectRate: 0,
      medianTimeToReviewMs: null,
    })
  })
})
