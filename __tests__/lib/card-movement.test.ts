import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordCardMovement } from '../../src/lib/card-movement'

describe('recordCardMovement', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes a row with from/to/actor when columns differ (positive)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'mv-1' })
    const tx = { cardMovement: { create } } as unknown as never

    const res = await recordCardMovement(tx, {
      cardId: 'card-1',
      boardId: 'board-1',
      orgId: 'org-1',
      fromColumnId: 'col-1',
      toColumnId: 'col-2',
      movedBy: { id: 'user-1', kind: 'user' },
    })

    expect(res).toEqual({ id: 'mv-1' })
    expect(create).toHaveBeenCalledWith({
      data: {
        cardId: 'card-1',
        boardId: 'board-1',
        orgId: 'org-1',
        fromColumnId: 'col-1',
        toColumnId: 'col-2',
        movedById: 'user-1',
        movedByKind: 'user',
      },
      select: { id: true },
    })
  })

  it('no-ops and returns null when from === to (negative/boundary)', async () => {
    const create = vi.fn()
    const tx = { cardMovement: { create } } as unknown as never

    const res = await recordCardMovement(tx, {
      cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
      fromColumnId: 'col-1', toColumnId: 'col-1',
      movedBy: { id: 'user-1', kind: 'user' },
    })

    expect(res).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('accepts a null fromColumnId (edge)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'mv-2' })
    const tx = { cardMovement: { create } } as unknown as never

    const res = await recordCardMovement(tx, {
      cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
      fromColumnId: null, toColumnId: 'col-2',
      movedBy: { id: 'agent-x', kind: 'agent' },
    })

    expect(res).toEqual({ id: 'mv-2' })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromColumnId: null, movedById: 'agent-x', movedByKind: 'agent' }),
      })
    )
  })
})

describe('formatRecentMovements', () => {
  function prismaWith(movements: unknown[], columns: unknown[], users: unknown[], earliest: unknown) {
    return {
      cardMovement: {
        findMany: vi.fn().mockResolvedValue(movements),
        findFirst: vi.fn().mockResolvedValue(earliest),
      },
      column: { findMany: vi.fn().mockResolvedValue(columns) },
      user: { findMany: vi.fn().mockResolvedValue(users) },
    } as unknown as never
  }

  it('renders movement lines with column and actor names (positive)', async () => {
    const prisma = prismaWith(
      [{ cardId: 'c1', fromColumnId: 'col-1', toColumnId: 'col-2', movedById: 'user-1', movedByKind: 'user', movedAt: new Date('2026-06-14T10:00:00Z'), card: { title: 'Spoonworks' } }],
      [{ id: 'col-1', name: 'In Progress' }, { id: 'col-2', name: 'Review' }],
      [{ id: 'user-1', name: 'Brad' }],
      { movedAt: new Date('2026-06-10T00:00:00Z') }
    )
    const { formatRecentMovements } = await import('../../src/lib/card-movement')
    const out = await formatRecentMovements(prisma, { boardId: 'board-1', orgId: 'org-1', sinceDays: 14 })
    expect(out).toContain('Recent movements')
    expect(out).toContain('"Spoonworks": In Progress → Review on 2026-06-14 by Brad')
  })

  it('returns an empty string when there are no movements (boundary)', async () => {
    const prisma = prismaWith([], [], [], null)
    const { formatRecentMovements } = await import('../../src/lib/card-movement')
    const out = await formatRecentMovements(prisma, { boardId: 'board-1', orgId: 'org-1' })
    expect(out).toBe('')
  })

  it('appends a not-tracked note when the window predates the earliest record (edge)', async () => {
    // Dates are relative to now so the assertion is clock-independent: the
    // earliest record sits inside the window while the window start (now −
    // sinceDays) predates it, which is exactly what triggers the note.
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const prisma = prismaWith(
      [{ cardId: 'c1', fromColumnId: 'col-1', toColumnId: 'col-2', movedById: 'AgentX', movedByKind: 'agent', movedAt: recent, card: { title: 'X' } }],
      [{ id: 'col-1', name: 'A' }, { id: 'col-2', name: 'B' }],
      [],
      { movedAt: new Date(recent.getTime() - 60 * 60 * 1000) }
    )
    const { formatRecentMovements } = await import('../../src/lib/card-movement')
    const out = await formatRecentMovements(prisma, { boardId: 'board-1', orgId: 'org-1', sinceDays: 30 })
    expect(out).toContain('not tracked')
    expect(out).toContain('by AgentX')
  })
})
