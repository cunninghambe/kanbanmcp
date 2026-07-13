/**
 * Tests for the lazy ChangeSet expiry helpers in src/lib/changesets.ts:
 * changeSetTtlDays (env-driven TTL), expireStaleChangeSets (sweep), and the
 * applyChangeSet status guard that makes expired/rejected sets un-appliable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PrismaClient } from '@prisma/client'

function mockDb(count: number) {
  return {
    changeSet: { updateMany: vi.fn().mockResolvedValue({ count }) },
  } as unknown as PrismaClient
}

describe('changeSetTtlDays', () => {
  const ORIGINAL = process.env.CHANGESET_TTL_DAYS

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CHANGESET_TTL_DAYS
    else process.env.CHANGESET_TTL_DAYS = ORIGINAL
  })

  it('POSITIVE: returns the parsed env override', async () => {
    process.env.CHANGESET_TTL_DAYS = '30'
    const { changeSetTtlDays } = await import('../../src/lib/changesets')
    expect(changeSetTtlDays()).toBe(30)
  })

  it('NEGATIVE: unset env falls back to the default of 14', async () => {
    delete process.env.CHANGESET_TTL_DAYS
    const { changeSetTtlDays } = await import('../../src/lib/changesets')
    expect(changeSetTtlDays()).toBe(14)
  })

  it('EDGE: garbage env falls back to the default of 14', async () => {
    process.env.CHANGESET_TTL_DAYS = 'garbage'
    const { changeSetTtlDays } = await import('../../src/lib/changesets')
    expect(changeSetTtlDays()).toBe(14)
  })

  it('EDGE: a value below the 1-day minimum is clamped up to 1', async () => {
    process.env.CHANGESET_TTL_DAYS = '0'
    const { changeSetTtlDays } = await import('../../src/lib/changesets')
    expect(changeSetTtlDays()).toBe(1)
  })
})

describe('expireStaleChangeSets', () => {
  const ORIGINAL = process.env.CHANGESET_TTL_DAYS

  beforeEach(() => {
    delete process.env.CHANGESET_TTL_DAYS
  })

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CHANGESET_TTL_DAYS
    else process.env.CHANGESET_TTL_DAYS = ORIGINAL
  })

  it('POSITIVE: sweeps org-scoped pending sets older than the TTL to expired and returns the count', async () => {
    const db = mockDb(2)
    const now = new Date('2026-07-13T10:00:00Z')
    const { expireStaleChangeSets } = await import('../../src/lib/changesets')
    const count = await expireStaleChangeSets(db, 'org-1', now)

    expect(count).toBe(2)
    expect(db.changeSet.updateMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', status: 'pending', createdAt: { lt: new Date('2026-06-29T10:00:00Z') } },
      data: { status: 'expired' },
    })
  })

  it('NEGATIVE: only targets status "pending" — partially_applied sets are excluded by the where clause', async () => {
    const db = mockDb(0)
    const { expireStaleChangeSets } = await import('../../src/lib/changesets')
    await expireStaleChangeSets(db, 'org-1', new Date('2026-07-13T10:00:00Z'))

    const where = (db.changeSet.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where
    expect(where.status).toBe('pending')
  })

  it('EDGE: respects a TTL env override when computing the cutoff', async () => {
    process.env.CHANGESET_TTL_DAYS = '5'
    const db = mockDb(1)
    const now = new Date('2026-07-13T10:00:00Z')
    const { expireStaleChangeSets } = await import('../../src/lib/changesets')
    await expireStaleChangeSets(db, 'org-1', now)

    expect(db.changeSet.updateMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', status: 'pending', createdAt: { lt: new Date('2026-07-08T10:00:00Z') } },
      data: { status: 'expired' },
    })
  })

  it('EDGE: garbage TTL env falls back to the 14-day default cutoff', async () => {
    process.env.CHANGESET_TTL_DAYS = 'not-a-number'
    const db = mockDb(0)
    const now = new Date('2026-07-13T10:00:00Z')
    const { expireStaleChangeSets } = await import('../../src/lib/changesets')
    await expireStaleChangeSets(db, 'org-1', now)

    expect(db.changeSet.updateMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', status: 'pending', createdAt: { lt: new Date('2026-06-29T10:00:00Z') } },
      data: { status: 'expired' },
    })
  })
})

// ─── validateChangeItemsOrgScope (propose-time per-item org-scope guard) ─────
//
// Detector contract — all four shapes: POSITIVE (in-org ids pass), NEGATIVE /
// FP-boundary (suspicious-looking but valid input stays silent), EDGE (each
// foreign id position + nonexistent + mixed), DEGRADATION (unparseable payload).
describe('validateChangeItemsOrgScope', () => {
  type ScopeDb = Parameters<typeof import('../../src/lib/changesets').validateChangeItemsOrgScope>[0]

  /** A mock db whose findMany returns only the ids named as "present" (in-org). */
  function scopeDb(present: { cards?: string[]; columns?: string[]; boards?: string[] } = {}) {
    const pick = (pool: string[] | undefined) =>
      vi.fn().mockImplementation((args: { where: { id: { in: string[] } } }) => {
        const set = new Set(pool ?? [])
        return Promise.resolve(args.where.id.in.filter((id) => set.has(id)).map((id) => ({ id })))
      })
    return {
      card: { findMany: pick(present.cards) },
      column: { findMany: pick(present.columns) },
      board: { findMany: pick(present.boards) },
    } as unknown as ScopeDb & {
      card: { findMany: ReturnType<typeof vi.fn> }
      column: { findMany: ReturnType<typeof vi.fn> }
      board: { findMany: ReturnType<typeof vi.fn> }
    }
  }

  const moveItem = (over: Record<string, unknown> = {}) => ({
    op: 'move_card' as const,
    payload: { cardId: 'card-1', columnId: 'col-1', position: 1 },
    ...over,
  })
  const createItem = (over: Record<string, unknown> = {}) => ({
    op: 'create_card' as const,
    payload: { boardId: 'board-1', columnId: 'col-1', title: 'T' },
    ...over,
  })
  const commentItem = (over: Record<string, unknown> = {}) => ({
    op: 'comment_card' as const,
    payload: { cardId: 'card-1', content: 'done' },
    ...over,
  })
  const updateItem = (over: Record<string, unknown> = {}) => ({
    op: 'update_card' as const,
    payload: { cardId: 'card-1', title: 'X' },
    ...over,
  })

  it('POSITIVE: every op with only in-org ids passes, items preserved in order', async () => {
    const db = scopeDb({ cards: ['card-1'], columns: ['col-1'], boards: ['board-1'] })
    const items = [createItem(), moveItem(), updateItem(), commentItem()]
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', items)

    expect(res.invalid).toEqual([])
    expect(res.validItems).toEqual(items)
  })

  it('NEGATIVE / FP boundary: a valid targetCardId alongside a valid payload cardId is NOT flagged', async () => {
    // Near-miss: targetCardId is an extra card-id position a naive check could
    // trip on; here both it and the payload cardId resolve in-org → silent.
    const db = scopeDb({ cards: ['card-1', 'card-2'], columns: ['col-1'] })
    const items = [moveItem({ targetCardId: 'card-2' })]
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', items)

    expect(res.invalid).toEqual([])
    expect(res.validItems).toHaveLength(1)
  })

  it('EDGE: a foreign cardId in move_card fires with a card/index/message finding', async () => {
    const db = scopeDb({ columns: ['col-1'] }) // card-1 absent → foreign
    const items = [moveItem()]
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', items)

    expect(res.validItems).toEqual([])
    expect(res.invalid).toHaveLength(1)
    expect(res.invalid[0].index).toBe(0)
    expect(res.invalid[0].reason).toMatch(/card/)
    expect(res.invalid[0].reason).toContain('card-1')
  })

  it('EDGE: a foreign columnId in create_card fires (board in-org, column not)', async () => {
    const db = scopeDb({ boards: ['board-1'] }) // col-1 absent
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', [createItem()])
    expect(res.validItems).toEqual([])
    expect(res.invalid[0].reason).toMatch(/column/)
  })

  it('EDGE: a foreign boardId in create_card fires (column in-org, board not)', async () => {
    const db = scopeDb({ columns: ['col-1'] }) // board-1 absent
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', [createItem()])
    expect(res.validItems).toEqual([])
    expect(res.invalid[0].reason).toMatch(/board/)
  })

  it('EDGE: a foreign targetCardId fires even when the payload cardId is in-org', async () => {
    const db = scopeDb({ cards: ['card-1'], columns: ['col-1'] }) // target card-9 absent
    const items = [moveItem({ targetCardId: 'card-9' })]
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', items)
    expect(res.validItems).toEqual([])
    expect(res.invalid[0].reason).toContain('card-9')
  })

  it('EDGE: a nonexistent id is handled the same as foreign (indistinguishable)', async () => {
    const db = scopeDb({}) // nothing present at all
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', [commentItem({ payload: { cardId: 'ghost', content: 'x' } })])
    expect(res.validItems).toEqual([])
    expect(res.invalid[0].reason).toMatch(/not found or not in this org/)
  })

  it('EDGE: a mixed set keeps in-org items and reports only the foreign ones by index', async () => {
    const db = scopeDb({ cards: ['card-1'], columns: ['col-1'], boards: ['board-1'] })
    const items = [
      commentItem(), // valid (index 0)
      moveItem({ payload: { cardId: 'foreign', columnId: 'col-1', position: 1 } }), // invalid (index 1)
      createItem(), // valid (index 2)
    ]
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', items)

    expect(res.invalid).toHaveLength(1)
    expect(res.invalid[0].index).toBe(1)
    expect(res.validItems).toEqual([items[0], items[2]])
  })

  it('EDGE (batching / no N+1): ids are de-duped into one findMany per entity type', async () => {
    const db = scopeDb({ cards: ['card-1'], columns: ['col-1'] })
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    await validateChangeItemsOrgScope(db, 'org-1', [commentItem(), updateItem(), moveItem()])

    // three card refs but all "card-1" → single query, single id
    expect(db.card.findMany).toHaveBeenCalledTimes(1)
    expect(db.card.findMany.mock.calls[0][0].where.id.in).toEqual(['card-1'])
    // no board refs among these ops → board.findMany never called
    expect(db.board.findMany).not.toHaveBeenCalled()
  })

  it('DEGRADATION: a shape-invalid payload is flagged invalid, not thrown', async () => {
    const db = scopeDb({ columns: ['col-1'], boards: ['board-1'] })
    // create_card missing required title → unparseable against its op schema
    const items = [{ op: 'create_card' as const, payload: { boardId: 'board-1', columnId: 'col-1' } }]
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', items)
    expect(res.validItems).toEqual([])
    expect(res.invalid[0].reason).toMatch(/unreadable payload/)
  })

  it('DEGRADATION: an empty item list returns empty and queries nothing', async () => {
    const db = scopeDb({})
    const { validateChangeItemsOrgScope } = await import('../../src/lib/changesets')
    const res = await validateChangeItemsOrgScope(db, 'org-1', [])
    expect(res).toEqual({ validItems: [], invalid: [] })
    expect(db.card.findMany).not.toHaveBeenCalled()
    expect(db.column.findMany).not.toHaveBeenCalled()
    expect(db.board.findMany).not.toHaveBeenCalled()
  })
})

describe('applyChangeSet on a non-actionable status (edge case 6: expiry makes apply un-appliable)', () => {
  it('EDGE: an expired ChangeSet is refused with reason "invalid_status" and nothing is applied', async () => {
    const mockPrisma = {
      changeSet: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'cs-1',
          status: 'expired',
          items: [{ id: 'item-1', op: 'create_card', payload: '{}', decision: 'pending' }],
        }),
        update: vi.fn(),
      },
      changeItem: { update: vi.fn(), count: vi.fn() },
      $transaction: vi.fn(),
    } as unknown as Parameters<typeof import('../../src/lib/changesets').applyChangeSet>[0]

    const { applyChangeSet } = await import('../../src/lib/changesets')
    const res = await applyChangeSet(mockPrisma, 'cs-1', { orgId: 'org-1', userId: 'user-1' })

    expect(res).toEqual({ ok: false, reason: 'invalid_status' })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.changeSet.update).not.toHaveBeenCalled()
  })

  it('NEGATIVE: a rejected ChangeSet is likewise refused (not just expired)', async () => {
    const mockPrisma = {
      changeSet: {
        findFirst: vi.fn().mockResolvedValue({ id: 'cs-1', status: 'rejected', items: [] }),
        update: vi.fn(),
      },
      changeItem: { update: vi.fn(), count: vi.fn() },
      $transaction: vi.fn(),
    } as unknown as Parameters<typeof import('../../src/lib/changesets').applyChangeSet>[0]

    const { applyChangeSet } = await import('../../src/lib/changesets')
    const res = await applyChangeSet(mockPrisma, 'cs-1', { orgId: 'org-1', userId: 'user-1' })

    expect(res).toEqual({ ok: false, reason: 'invalid_status' })
  })

  it('POSITIVE (regression guard): pending and partially_applied still proceed to apply', async () => {
    for (const status of ['pending', 'partially_applied']) {
      const tx = { card: { findFirst: vi.fn() } }
      const mockPrisma = {
        changeSet: {
          findFirst: vi.fn().mockResolvedValue({ id: 'cs-1', status, items: [] }),
          update: vi.fn(),
        },
        changeItem: { update: vi.fn(), count: vi.fn().mockResolvedValue(0) },
        $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      } as unknown as Parameters<typeof import('../../src/lib/changesets').applyChangeSet>[0]

      const { applyChangeSet } = await import('../../src/lib/changesets')
      const res = await applyChangeSet(mockPrisma, 'cs-1', { orgId: 'org-1', userId: 'user-1' })
      expect(res.ok).toBe(true)
    }
  })
})
