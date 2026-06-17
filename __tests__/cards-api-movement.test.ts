import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))

vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

const recordCardMovement = vi.fn().mockResolvedValue({ id: 'mv-1' })
vi.mock('../src/lib/card-movement', () => ({ recordCardMovement }))

const mockPrisma = {
  card: { findUnique: vi.fn(), findMany: vi.fn() },
  orgMember: { findUnique: vi.fn() },
  label: { findMany: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock('../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('PATCH /api/cards/[cardId] movement recording', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  function txClient() {
    return {
      card: { update: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue({ position: 2 }) },
      cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
      cardMovement: { create: vi.fn() },
    }
  }

  it('records a movement when columnId changes (positive)', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', boardId: 'board-1', board: { orgId: 'org-1' }, column: { name: 'Backlog' } })
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-2', labels: [], comments: [] })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: ReturnType<typeof txClient>) => Promise<unknown>) => fn(txClient()))

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const res = await PATCH(makeRequest('http://localhost/api/cards/card-1', 'PATCH', { columnId: 'col-2' }), {
      params: Promise.resolve({ cardId: 'card-1' }),
    })

    expect(res.status).toBe(200)
    expect(recordCardMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
        fromColumnId: 'col-1', toColumnId: 'col-2',
        movedBy: { id: 'user-1', kind: 'user' },
      })
    )
  })

  it('does NOT record when only the title changes (negative)', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', boardId: 'board-1', board: { orgId: 'org-1' }, column: { name: 'Backlog' } })
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', labels: [], comments: [] })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: ReturnType<typeof txClient>) => Promise<unknown>) => fn(txClient()))

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const res = await PATCH(makeRequest('http://localhost/api/cards/card-1', 'PATCH', { title: 'Renamed' }), {
      params: Promise.resolve({ cardId: 'card-1' }),
    })

    expect(res.status).toBe(200)
    expect(recordCardMovement).not.toHaveBeenCalled()
  })

  it('does NOT record when columnId equals current column (boundary)', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', boardId: 'board-1', board: { orgId: 'org-1' }, column: { name: 'Backlog' } })
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', labels: [], comments: [] })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: ReturnType<typeof txClient>) => Promise<unknown>) => fn(txClient()))

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const res = await PATCH(makeRequest('http://localhost/api/cards/card-1', 'PATCH', { columnId: 'col-1' }), {
      params: Promise.resolve({ cardId: 'card-1' }),
    })

    expect(res.status).toBe(200)
    expect(recordCardMovement).not.toHaveBeenCalled()
  })
})
