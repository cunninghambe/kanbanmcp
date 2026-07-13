/**
 * Tests for the ChangeSet review surface:
 *  - GET  /api/changesets            (list, expiry sweep, hudSessionTitle)
 *  - GET  /api/changesets/[id]       (detail, expiry sweep, display strings)
 *  - POST /api/changesets/[id]/decisions (reject-all recomputes set status)
 *
 * See docs/specs/2026-07-13-hud-meeting-manager.md §3.4 and §4 edge cases 6-7.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = {
  userId: 'user-1',
  orgId: 'org-1',
  save: vi.fn(),
}

vi.mock('iron-session', () => ({
  getIronSession: vi.fn().mockResolvedValue(mockSession),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockReturnValue({}),
}))

const mockPrisma = {
  changeSet: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  changeItem: {
    update: vi.fn(),
  },
  hudSession: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  orgMember: {
    findUnique: vi.fn(),
  },
  card: { findMany: vi.fn().mockResolvedValue([]) },
  column: { findMany: vi.fn().mockResolvedValue([]) },
  board: { findMany: vi.fn().mockResolvedValue([]) },
  $transaction: vi.fn(),
}

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

const membership = { userId: 'user-1', orgId: 'org-1', role: 'MEMBER' }

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mockSession, { isApiKeyAuth: undefined, agentName: undefined })
  mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
  mockPrisma.changeSet.updateMany.mockResolvedValue({ count: 0 })
  mockPrisma.hudSession.findMany.mockResolvedValue([])
  mockPrisma.card.findMany.mockResolvedValue([])
  mockPrisma.column.findMany.mockResolvedValue([])
  mockPrisma.board.findMany.mockResolvedValue([])
})

// ─── GET /api/changesets ───────────────────────────────────────────────────

describe('GET /api/changesets', () => {
  it('POSITIVE: sweeps expiry before reading and includes hudSessionTitle joined from hudSessionId', async () => {
    mockPrisma.changeSet.findMany.mockResolvedValue([
      {
        id: 'cs-1',
        status: 'expired',
        summary: 'Board updates',
        boardId: 'board-1',
        hudSessionId: 'hud-1',
        dispatchId: null,
        createdById: 'agent-1',
        createdAt: new Date('2026-06-28T10:00:00Z'),
        _count: { items: 1 },
      },
      {
        id: 'cs-2',
        status: 'pending',
        summary: null,
        boardId: null,
        hudSessionId: null,
        dispatchId: null,
        createdById: 'agent-1',
        createdAt: new Date('2026-07-12T10:00:00Z'),
        _count: { items: 1 },
      },
    ])
    mockPrisma.hudSession.findMany.mockResolvedValue([{ id: 'hud-1', title: 'Sprint Planning' }])

    const { GET } = await import('../../src/app/api/changesets/route')
    const req = makeRequest('http://localhost/api/changesets', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(mockPrisma.changeSet.updateMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', status: 'pending', createdAt: { lt: expect.any(Date) } },
      data: { status: 'expired' },
    })
    const sweepOrder = mockPrisma.changeSet.updateMany.mock.invocationCallOrder[0]
    const readOrder = mockPrisma.changeSet.findMany.mock.invocationCallOrder[0]
    expect(sweepOrder).toBeLessThan(readOrder)

    expect(body.changeSets[0].hudSessionTitle).toBe('Sprint Planning')
    expect(body.changeSets[1].hudSessionTitle).toBeNull()
  })

  it('EDGE: a hudSessionId with no matching session degrades hudSessionTitle to null', async () => {
    mockPrisma.changeSet.findMany.mockResolvedValue([
      {
        id: 'cs-1',
        status: 'pending',
        summary: null,
        boardId: null,
        hudSessionId: 'hud-deleted',
        dispatchId: null,
        createdById: 'agent-1',
        createdAt: new Date(),
        _count: { items: 1 },
      },
    ])
    mockPrisma.hudSession.findMany.mockResolvedValue([])

    const { GET } = await import('../../src/app/api/changesets/route')
    const req = makeRequest('http://localhost/api/changesets', 'GET')
    const res = await GET(req)
    const body = await res.json()
    expect(body.changeSets[0].hudSessionTitle).toBeNull()
  })
})

// ─── GET /api/changesets/[id] ──────────────────────────────────────────────

describe('GET /api/changesets/[id]', () => {
  it('POSITIVE: sweeps expiry before reading and every item gains a display string', async () => {
    mockPrisma.changeSet.findFirst.mockResolvedValue({
      id: 'cs-1',
      status: 'pending',
      items: [
        {
          id: 'item-1',
          op: 'create_card',
          payload: JSON.stringify({ boardId: 'board-1', columnId: 'col-1', title: 'Ship it' }),
          evidence: null,
          resolution: null,
          targetCardId: null,
        },
        {
          id: 'item-2',
          op: 'comment_card',
          payload: 'not valid json',
          evidence: null,
          resolution: null,
          targetCardId: null,
        },
      ],
    })
    mockPrisma.column.findMany.mockResolvedValue([{ id: 'col-1', name: 'Backlog' }])
    mockPrisma.board.findMany.mockResolvedValue([{ id: 'board-1', name: 'Roadmap' }])

    const { GET } = await import('../../src/app/api/changesets/[id]/route')
    const req = makeRequest('http://localhost/api/changesets/cs-1', 'GET')
    const res = await GET(req, { params: Promise.resolve({ id: 'cs-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(mockPrisma.changeSet.updateMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', status: 'pending', createdAt: { lt: expect.any(Date) } },
      data: { status: 'expired' },
    })
    const sweepOrder = mockPrisma.changeSet.updateMany.mock.invocationCallOrder[0]
    const readOrder = mockPrisma.changeSet.findFirst.mock.invocationCallOrder[0]
    expect(sweepOrder).toBeLessThan(readOrder)

    expect(body.changeSet.items[0].display).toBe('Create card "Ship it" in Backlog on Roadmap')
    expect(body.changeSet.items[1].display).toBe('comment_card (unreadable payload)')
  })

  it('returns 404 when the ChangeSet belongs to another org', async () => {
    mockPrisma.changeSet.findFirst.mockResolvedValue(null)
    const { GET } = await import('../../src/app/api/changesets/[id]/route')
    const req = makeRequest('http://localhost/api/changesets/cs-1', 'GET')
    const res = await GET(req, { params: Promise.resolve({ id: 'cs-1' }) })
    expect(res.status).toBe(404)
  })
})

// ─── POST /api/changesets/[id]/decisions ───────────────────────────────────

describe('POST /api/changesets/[id]/decisions', () => {
  beforeEach(() => {
    mockPrisma.changeSet.findFirst.mockResolvedValue({
      id: 'cs-1',
      items: [{ id: 'item-1' }, { id: 'item-2' }],
    })
    mockPrisma.$transaction.mockResolvedValue(undefined)
  })

  it('EDGE (case 7): rejecting a strict subset leaves the ChangeSet status "pending"', async () => {
    mockPrisma.changeSet.findUnique.mockResolvedValue({
      id: 'cs-1',
      status: 'pending',
      items: [
        { id: 'item-1', decision: 'rejected' },
        { id: 'item-2', decision: 'pending' },
      ],
    })

    const { POST } = await import('../../src/app/api/changesets/[id]/decisions/route')
    const req = makeRequest('http://localhost/api/changesets/cs-1/decisions', 'POST', {
      decisions: [{ itemId: 'item-1', decision: 'rejected' }],
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'cs-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.changeSet.status).toBe('pending')
    expect(mockPrisma.changeSet.update).not.toHaveBeenCalled()
  })

  it('POSITIVE (case 7): rejecting the remainder later flips the set status to "rejected"', async () => {
    mockPrisma.changeSet.findUnique.mockResolvedValue({
      id: 'cs-1',
      status: 'pending',
      items: [
        { id: 'item-1', decision: 'rejected' },
        { id: 'item-2', decision: 'rejected' },
      ],
    })
    mockPrisma.changeSet.update.mockResolvedValue({
      id: 'cs-1',
      status: 'rejected',
      items: [
        { id: 'item-1', decision: 'rejected' },
        { id: 'item-2', decision: 'rejected' },
      ],
    })

    const { POST } = await import('../../src/app/api/changesets/[id]/decisions/route')
    const req = makeRequest('http://localhost/api/changesets/cs-1/decisions', 'POST', {
      decisions: [{ itemId: 'item-2', decision: 'rejected' }],
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'cs-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.changeSet.status).toBe('rejected')
    expect(mockPrisma.changeSet.update).toHaveBeenCalledWith({
      where: { id: 'cs-1' },
      data: { status: 'rejected' },
      include: { items: true },
    })
  })

  it('NEGATIVE: a mix of approved and rejected decisions does not flip the status', async () => {
    mockPrisma.changeSet.findUnique.mockResolvedValue({
      id: 'cs-1',
      status: 'pending',
      items: [
        { id: 'item-1', decision: 'approved' },
        { id: 'item-2', decision: 'rejected' },
      ],
    })

    const { POST } = await import('../../src/app/api/changesets/[id]/decisions/route')
    const req = makeRequest('http://localhost/api/changesets/cs-1/decisions', 'POST', {
      decisions: [
        { itemId: 'item-1', decision: 'approved' },
        { itemId: 'item-2', decision: 'rejected' },
      ],
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'cs-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.changeSet.status).toBe('pending')
    expect(mockPrisma.changeSet.update).not.toHaveBeenCalled()
  })
})
