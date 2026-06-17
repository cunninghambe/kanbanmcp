import { describe, it, expect, vi, beforeEach } from 'vitest'

const recordCardMovement = vi.fn().mockResolvedValue({ id: 'mv-1' })
vi.mock('../../src/lib/card-movement', () => ({ recordCardMovement }))

describe('applyChangeSet move_card movement recording', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records a movement attributed to the approving user (positive)', async () => {
    const tx = {
      card: { findFirst: vi.fn().mockResolvedValue({ id: 'card-1', columnId: 'col-1', boardId: 'board-1' }), update: vi.fn().mockResolvedValue({}) },
      column: { findFirst: vi.fn().mockResolvedValue({ id: 'col-2', boardId: 'board-1' }) },
      cardMovement: { create: vi.fn() },
    }
    const item = { id: 'item-1', op: 'move_card', payload: JSON.stringify({ cardId: 'card-1', columnId: 'col-2', position: 1 }), decision: 'pending' }
    const mockPrisma = {
      changeSet: { findFirst: vi.fn().mockResolvedValue({ id: 'cs-1', status: 'pending', items: [item] }), update: vi.fn() },
      changeItem: { update: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as Parameters<typeof import('../../src/lib/changesets').applyChangeSet>[0]

    const { applyChangeSet } = await import('../../src/lib/changesets')
    const res = await applyChangeSet(mockPrisma, 'cs-1', { orgId: 'org-1', userId: 'approver-1' })

    expect(res.ok).toBe(true)
    expect(recordCardMovement).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
        fromColumnId: 'col-1', toColumnId: 'col-2',
        movedBy: { id: 'approver-1', kind: 'user' },
      })
    )
  })
})
