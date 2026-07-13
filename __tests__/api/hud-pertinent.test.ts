/**
 * Tests for GET /api/hud/[id]/pertinent — board-derived situational context for
 * the HUD rail: overdue, stalled, due-this-week, and moved-this-session cards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  hudSession: { findFirst: vi.fn() },
  board: { findFirst: vi.fn() },
  cardMovement: { findMany: vi.fn() },
  column: { findMany: vi.fn() },
  orgMember: { findUnique: vi.fn() },
}

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' })
}

const membership = { userId: 'user-1', orgId: 'org-1', role: 'MEMBER' }
const NOW = new Date('2026-07-13T12:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

function card(overrides: Record<string, unknown>) {
  return {
    id: 'card-1',
    title: 'Card',
    priority: 'medium',
    dueDate: null as Date | null,
    updatedAt: NOW,
    column: { name: 'In Progress' },
    ...overrides,
  }
}

async function getPertinent() {
  const { GET } = await import('../../src/app/api/hud/[id]/pertinent/route')
  const res = await GET(makeRequest('http://localhost/api/hud/hud-1/pertinent'), { params: Promise.resolve({ id: 'hud-1' }) })
  return { res, body: await res.json() }
}

describe('GET /api/hud/[id]/pertinent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    mockPrisma.hudSession.findFirst.mockResolvedValue({
      id: 'hud-1',
      boardId: 'board-1',
      startedAt: new Date('2026-07-13T09:00:00Z'),
    })
    mockPrisma.board.findFirst.mockResolvedValue({ id: 'board-1', name: 'Board', columns: [] })
    mockPrisma.cardMovement.findMany.mockResolvedValue([])
    mockPrisma.column.findMany.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('POSITIVE: dueSoon includes cards due within the next 7 days, sorted ascending, cap in counts', async () => {
    mockPrisma.board.findFirst.mockResolvedValue({
      id: 'board-1',
      name: 'Board',
      columns: [{
        cards: [
          card({ id: 'c-later', dueDate: new Date(NOW.getTime() + 5 * DAY_MS) }),
          card({ id: 'c-sooner', dueDate: new Date(NOW.getTime() + 1 * DAY_MS) }),
        ],
      }],
    })
    const { body } = await getPertinent()
    expect(body.dueSoon.map((c: { id: string }) => c.id)).toEqual(['c-sooner', 'c-later'])
    expect(body.counts.dueSoon).toBe(2)
  })

  it('NEGATIVE: a card both overdue and within the due-soon window appears only in overdue', async () => {
    mockPrisma.board.findFirst.mockResolvedValue({
      id: 'board-1',
      name: 'Board',
      columns: [{ cards: [card({ id: 'c-overdue', dueDate: new Date(NOW.getTime() - DAY_MS) })] }],
    })
    const { body } = await getPertinent()
    expect(body.overdue.map((c: { id: string }) => c.id)).toEqual(['c-overdue'])
    expect(body.dueSoon).toEqual([])
  })

  it('EDGE: a due date exactly now+7d is excluded from dueSoon (upper bound exclusive)', async () => {
    mockPrisma.board.findFirst.mockResolvedValue({
      id: 'board-1',
      name: 'Board',
      columns: [{
        cards: [
          card({ id: 'c-boundary', dueDate: new Date(NOW.getTime() + 7 * DAY_MS) }),
          card({ id: 'c-in-window', dueDate: new Date(NOW.getTime() + 7 * DAY_MS - 1) }),
        ],
      }],
    })
    const { body } = await getPertinent()
    expect(body.dueSoon.map((c: { id: string }) => c.id)).toEqual(['c-in-window'])
  })

  it('EDGE: a due date exactly now is included in dueSoon (lower bound inclusive) and is not overdue', async () => {
    mockPrisma.board.findFirst.mockResolvedValue({
      id: 'board-1',
      name: 'Board',
      columns: [{ cards: [card({ id: 'c-now', dueDate: new Date(NOW.getTime()) })] }],
    })
    const { body } = await getPertinent()
    expect(body.dueSoon.map((c: { id: string }) => c.id)).toEqual(['c-now'])
    expect(body.overdue).toEqual([])
  })

  it('EDGE: a terminal-column card due this week is excluded entirely', async () => {
    mockPrisma.board.findFirst.mockResolvedValue({
      id: 'board-1',
      name: 'Board',
      columns: [{
        cards: [card({ id: 'c-done', column: { name: 'Done' }, dueDate: new Date(NOW.getTime() + DAY_MS) })],
      }],
    })
    const { body } = await getPertinent()
    expect(body.dueSoon).toEqual([])
  })

  it('POSITIVE: movedThisSession lists movements since the session startedAt, resolved via listMovementsSince', async () => {
    mockPrisma.cardMovement.findMany.mockResolvedValue([
      { cardId: 'c1', fromColumnId: 'col-1', toColumnId: 'col-2', movedAt: new Date('2026-07-13T10:00:00Z'), card: { title: 'Moved Card' } },
    ])
    mockPrisma.column.findMany.mockResolvedValue([{ id: 'col-1', name: 'Backlog' }, { id: 'col-2', name: 'Doing' }])

    const { body } = await getPertinent()

    expect(body.movedThisSession).toEqual([
      { cardId: 'c1', cardTitle: 'Moved Card', fromColumn: 'Backlog', toColumn: 'Doing', movedAt: '2026-07-13T10:00:00.000Z' },
    ])
    expect(body.counts.movedThisSession).toBe(1)
    expect(mockPrisma.cardMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { boardId: 'board-1', orgId: 'org-1', movedAt: { gte: new Date('2026-07-13T09:00:00Z') } },
        take: 8,
      })
    )
  })

  it('EDGE: a boardless session returns empty dueSoon/movedThisSession and zeroed counts, skipping the movement lookup', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue({ id: 'hud-1', boardId: null, startedAt: NOW })
    const { body } = await getPertinent()
    expect(body.dueSoon).toEqual([])
    expect(body.movedThisSession).toEqual([])
    expect(body.counts).toEqual({ overdue: 0, stalled: 0, aging: 0, total: 0, dueSoon: 0, movedThisSession: 0 })
    expect(mockPrisma.cardMovement.findMany).not.toHaveBeenCalled()
  })

  it('NEGATIVE: returns 404 for a HUD session in another org', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue(null)
    const { res } = await getPertinent()
    expect(res.status).toBe(404)
  })
})
