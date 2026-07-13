/**
 * Tests for the lazy ChangeSet expiry helpers in src/lib/changesets.ts:
 * changeSetTtlDays (env-driven TTL) and expireStaleChangeSets (sweep).
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
