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
