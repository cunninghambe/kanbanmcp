/**
 * Unit tests for src/lib/tree.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { recomputeSubtreePathAndDepth, wouldFormCycle } from '../../src/lib/tree'

function makeTx(
  cards: Record<string, { path: string; depth: number; parentCardId?: string | null }>
) {
  const updateCalls: Array<{ id: string; data: Record<string, unknown> }> = []

  const tx = {
    card: {
      findUnique: vi.fn(
        ({ where, select }: { where: { id: string }; select: Record<string, boolean> }) => {
          const c = cards[where.id]
          if (!c) return Promise.resolve(null)
          const result: Record<string, unknown> = {}
          if ('path' in select) result.path = c.path
          if ('depth' in select) result.depth = c.depth
          if ('parentCardId' in select) result.parentCardId = c.parentCardId ?? null
          return Promise.resolve(result)
        }
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updateCalls.push({ id: where.id, data })
        return Promise.resolve({})
      }),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
    _updateCalls: updateCalls,
  }
  return tx
}

describe('recomputeSubtreePathAndDepth', () => {
  it('sets path="" depth=0 when newParentId=null (promote to root)', async () => {
    const tx = makeTx({ 'card-A': { path: '/parent-1/', depth: 1 } })
    await recomputeSubtreePathAndDepth(tx as never, 'card-A', null)
    expect(tx._updateCalls[0]).toMatchObject({ id: 'card-A', data: { path: '', depth: 0 } })
    expect(tx.$executeRaw).toHaveBeenCalled()
  })

  it('computes correct child path when parent is root', async () => {
    const tx = makeTx({
      'card-A': { path: '', depth: 0 },
      'card-B': { path: '', depth: 0 },
    })
    await recomputeSubtreePathAndDepth(tx as never, 'card-A', 'card-B')
    expect(tx._updateCalls[0]).toMatchObject({
      id: 'card-A',
      data: { path: '/card-B/', depth: 1 },
    })
  })

  it('computes correct child path when parent is nested', async () => {
    const tx = makeTx({
      'card-A': { path: '', depth: 0 },
      'card-B': { path: '/card-C/', depth: 1 },
    })
    await recomputeSubtreePathAndDepth(tx as never, 'card-A', 'card-B')
    expect(tx._updateCalls[0]).toMatchObject({
      id: 'card-A',
      data: { path: '/card-C/card-B/', depth: 2 },
    })
  })

  it('returns updatedCount=0 when card not found', async () => {
    const tx = makeTx({})
    const result = await recomputeSubtreePathAndDepth(tx as never, 'missing', null)
    expect(result.updatedCount).toBe(0)
    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })

  it('returns updatedCount=0 when new parent not found', async () => {
    const tx = makeTx({ 'card-A': { path: '', depth: 0 } })
    const result = await recomputeSubtreePathAndDepth(tx as never, 'card-A', 'nonexistent')
    expect(result.updatedCount).toBe(0)
    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })
})

describe('wouldFormCycle', () => {
  it('returns false when candidate has no parent (new parent is a root card)', async () => {
    const tx = makeTx({ 'card-B': { path: '', depth: 0, parentCardId: null } })
    const result = await wouldFormCycle(tx as never, 'card-A', 'card-B')
    expect(result).toBe(false)
  })

  it('returns true when candidate ancestor is the card itself', async () => {
    const tx = makeTx({
      'card-B': { path: '', depth: 0, parentCardId: 'card-A' },
      'card-A': { path: '', depth: 0, parentCardId: null },
    })
    const result = await wouldFormCycle(tx as never, 'card-A', 'card-B')
    expect(result).toBe(true)
  })

  it('returns false when ancestor chain does not include cardId', async () => {
    const tx = makeTx({
      'card-C': { path: '', depth: 2, parentCardId: 'card-B' },
      'card-B': { path: '', depth: 1, parentCardId: null },
    })
    const result = await wouldFormCycle(tx as never, 'card-A', 'card-C')
    expect(result).toBe(false)
  })
})
