/**
 * Tests for GET /api/hud/[id]/digest — the computed end-of-meeting digest
 * (stats + markdown) that feeds the wrap-up view. Works on live and ended
 * sessions; org MEMBER, read-only (no isApiKeyAuth gate).
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
  hudSession: {
    findFirst: vi.fn(),
  },
  hudEntry: {
    findMany: vi.fn(),
  },
  agentDispatch: {
    findMany: vi.fn(),
  },
  changeSet: {
    findMany: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  board: {
    findFirst: vi.fn(),
  },
  orgMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  apiKey: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
}

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' })
}

const membership = { userId: 'user-1', orgId: 'org-1', role: 'MEMBER' }

const baseHud = {
  id: 'hud-1',
  title: 'Weekly Sync',
  startedAt: new Date('2026-07-13T14:00:00'),
  endedAt: null as Date | null,
  boardId: 'board-1',
}

function entry(overrides: Record<string, unknown>) {
  return {
    id: 'entry-1',
    orgId: 'org-1',
    hudSessionId: 'hud-1',
    authorId: 'user-1',
    position: 0,
    checkedAt: null,
    assigneeId: null,
    dueDate: null,
    cardId: null,
    createdAt: new Date('2026-07-13T14:05:00'),
    updatedAt: new Date('2026-07-13T14:05:00'),
    ...overrides,
  }
}

describe('GET /api/hud/[id]/digest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    mockPrisma.hudSession.findFirst.mockResolvedValue({ ...baseHud })
    mockPrisma.hudEntry.findMany.mockResolvedValue([])
    mockPrisma.agentDispatch.findMany.mockResolvedValue([])
    mockPrisma.changeSet.findMany.mockResolvedValue([])
    mockPrisma.changeSet.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.board.findFirst.mockResolvedValue({ name: 'Product Board' })
    mockPrisma.orgMember.findMany.mockResolvedValue([])
  })

  it('POSITIVE: sweeps expired changesets before reading the session\'s changesets', async () => {
    const { GET } = await import('../../src/app/api/hud/[id]/digest/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/digest')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(200)

    expect(mockPrisma.changeSet.updateMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', status: 'pending', createdAt: { lt: expect.any(Date) } },
      data: { status: 'expired' },
    })
    const sweepOrder = mockPrisma.changeSet.updateMany.mock.invocationCallOrder[0]
    const readOrder = mockPrisma.changeSet.findMany.mock.invocationCallOrder[0]
    expect(sweepOrder).toBeLessThan(readOrder)
  })

  it('POSITIVE: returns 200 { digest } for a live session', async () => {
    const { GET } = await import('../../src/app/api/hud/[id]/digest/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/digest')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.digest.stats.durationMs).toBeNull()
    expect(body.digest.markdown).toContain('(live)')
  })

  it('POSITIVE: returns 200 { digest } for an ended session, with a computed duration', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue({
      ...baseHud,
      endedAt: new Date('2026-07-13T15:00:00'),
    })
    const { GET } = await import('../../src/app/api/hud/[id]/digest/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/digest')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.digest.stats.durationMs).toBe(60 * 60_000)
    expect(body.digest.markdown).not.toContain('(live)')
  })

  it('NEGATIVE: returns 404 when the HUD session belongs to another org', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue(null)
    const { GET } = await import('../../src/app/api/hud/[id]/digest/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/digest')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(404)
    expect(mockPrisma.hudEntry.findMany).not.toHaveBeenCalled()
  })

  it('NEGATIVE: returns 404 for an unknown session id', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue(null)
    const { GET } = await import('../../src/app/api/hud/[id]/digest/route')
    const req = makeRequest('http://localhost/api/hud/does-not-exist/digest')
    const res = await GET(req, { params: Promise.resolve({ id: 'does-not-exist' }) })
    expect(res.status).toBe(404)
  })

  it('POSITIVE: resolves assignee display names into the action items via a batched member lookup', async () => {
    mockPrisma.hudEntry.findMany.mockResolvedValue([
      entry({ kind: 'action', text: 'send contract', assigneeId: 'user-brad' }),
    ])
    mockPrisma.orgMember.findMany.mockResolvedValue([
      { userId: 'user-brad', orgId: 'org-1', role: 'MEMBER', user: { name: 'Brad Pitt' } },
    ])
    const { GET } = await import('../../src/app/api/hud/[id]/digest/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/digest')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.digest.actions).toEqual([
      { text: 'send contract', assigneeName: 'Brad Pitt', dueDate: null, cardId: null },
    ])
    expect(mockPrisma.orgMember.findMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', userId: { in: ['user-brad'] } },
      select: { userId: true, user: { select: { name: true } } },
    })
  })

  it('EDGE: no assigneeIds skips the member lookup entirely', async () => {
    mockPrisma.hudEntry.findMany.mockResolvedValue([entry({ kind: 'note', text: 'discussed budget' })])
    const { GET } = await import('../../src/app/api/hud/[id]/digest/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/digest')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(200)
    expect(mockPrisma.orgMember.findMany).not.toHaveBeenCalled()
  })

  it('EDGE: a session with no board omits the Board line and skips the board lookup', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue({ ...baseHud, boardId: null })
    const { GET } = await import('../../src/app/api/hud/[id]/digest/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/digest')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    const body = await res.json()
    expect(body.digest.markdown).not.toContain('**Board:**')
    expect(mockPrisma.board.findFirst).not.toHaveBeenCalled()
  })

  it('POSITIVE: proposed changesets carry summary/status/itemCount from _count.items', async () => {
    mockPrisma.changeSet.findMany.mockResolvedValue([
      { id: 'cs-1', status: 'pending', summary: 'Move 3 cards to Done', _count: { items: 3 } },
    ])
    const { GET } = await import('../../src/app/api/hud/[id]/digest/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/digest')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    const body = await res.json()
    expect(body.digest.changeSets).toEqual([
      { id: 'cs-1', status: 'pending', summary: 'Move 3 cards to Done', itemCount: 3 },
    ])
  })
})
