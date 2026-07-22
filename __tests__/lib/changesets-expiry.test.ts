import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  createPendingChangeSet,
  expireStaleChangeSets,
  applyChangeSet,
} from '../../src/lib/changesets'

// createPendingChangeSet / expireStaleChangeSets / applyChangeSet all take a
// PrismaClient argument, so we pass a minimal mock directly (no module mock).

function makePrisma(over: Record<string, unknown> = {}) {
  return {
    changeSet: {
      create: vi.fn().mockResolvedValue({ id: 'cs-1', items: [] }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    changeItem: {
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue({}),
    },
    ...over,
  } as unknown as PrismaClient
}

describe('changeset expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CHANGESET_TTL_DAYS
  })

  describe('createPendingChangeSet — expiresAt', () => {
    it('sets expiresAt to now + default 14 days', async () => {
      const prisma = makePrisma()
      const before = Date.now()
      await createPendingChangeSet(prisma, {
        orgId: 'org-1',
        createdById: 'svc',
        items: [{ op: 'comment_card', payload: { cardId: 'c1', content: 'hi' } }],
      })
      const after = Date.now()

      const create = (prisma.changeSet.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const expiresAt = create.data.expiresAt as Date
      expect(expiresAt).toBeInstanceOf(Date)
      const ms = expiresAt.getTime()
      expect(ms).toBeGreaterThanOrEqual(before + 14 * 24 * 60 * 60 * 1000)
      expect(ms).toBeLessThanOrEqual(after + 14 * 24 * 60 * 60 * 1000)
    })

    it('honors CHANGESET_TTL_DAYS override', async () => {
      process.env.CHANGESET_TTL_DAYS = '3'
      const prisma = makePrisma()
      const before = Date.now()
      await createPendingChangeSet(prisma, {
        orgId: 'org-1',
        createdById: 'svc',
        items: [{ op: 'comment_card', payload: { cardId: 'c1', content: 'hi' } }],
      })
      const after = Date.now()

      const create = (prisma.changeSet.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const ms = (create.data.expiresAt as Date).getTime()
      expect(ms).toBeGreaterThanOrEqual(before + 3 * 24 * 60 * 60 * 1000)
      expect(ms).toBeLessThanOrEqual(after + 3 * 24 * 60 * 60 * 1000)
    })
  })

  describe('expireStaleChangeSets', () => {
    it('flips stale pending/partially_applied rows and returns the count', async () => {
      const prisma = makePrisma()
      ;(prisma.changeSet.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 })
      const now = new Date('2026-07-22T00:00:00Z')

      const n = await expireStaleChangeSets(prisma, now)

      expect(n).toBe(2)
      const arg = (prisma.changeSet.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(arg.where.status).toEqual({ in: ['pending', 'partially_applied'] })
      expect(arg.where.expiresAt).toEqual({ lt: now })
      expect(arg.data).toEqual({ status: 'expired' })
    })

    it('is idempotent — a second run flips nothing', async () => {
      const prisma = makePrisma()
      const updateMany = prisma.changeSet.updateMany as ReturnType<typeof vi.fn>
      updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

      expect(await expireStaleChangeSets(prisma)).toBe(1)
      expect(await expireStaleChangeSets(prisma)).toBe(0)
    })

    it('defaults now to the current time when omitted', async () => {
      const prisma = makePrisma()
      const before = Date.now()
      await expireStaleChangeSets(prisma)
      const after = Date.now()
      const arg = (prisma.changeSet.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const lt = (arg.where.expiresAt.lt as Date).getTime()
      expect(lt).toBeGreaterThanOrEqual(before)
      expect(lt).toBeLessThanOrEqual(after)
    })
  })

  describe('applyChangeSet — expired refusal', () => {
    it('refuses an expired ChangeSet with reason:expired', async () => {
      const prisma = makePrisma()
      ;(prisma.changeSet.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'cs-1',
        orgId: 'org-1',
        status: 'expired',
        items: [],
      })

      const result = await applyChangeSet(prisma, 'cs-1', { orgId: 'org-1', userId: 'u1' })

      expect(result).toEqual({ ok: false, reason: 'expired' })
      expect(prisma.changeSet.update).not.toHaveBeenCalled()
    })

    it('still applies a fresh pending ChangeSet', async () => {
      const prisma = makePrisma()
      ;(prisma.changeSet.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'cs-1',
        orgId: 'org-1',
        status: 'pending',
        items: [],
      })

      const result = await applyChangeSet(prisma, 'cs-1', { orgId: 'org-1', userId: 'u1' })

      expect(result.ok).toBe(true)
    })
  })
})
