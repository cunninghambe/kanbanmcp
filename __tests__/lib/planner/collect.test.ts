/**
 * The per-user collector (spec §4.4): upsert semantics, sticky user decisions,
 * every `resolveMissing` mode, error isolation per source, and the calendar
 * elapsed rule. Prisma is mocked; readers are fakes. (WI-1)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { collectForUser } from '../../../src/lib/planner/collect'
import { InsufficientScopesError } from '../../../src/lib/google/errors'
import type { SourceContext, SourceRead, SourceReader } from '../../../src/lib/planner/types'
import { dayBounds } from '../../../src/lib/planner/time'

const NOW = new Date('2026-09-16T09:00:00Z')
const CTX: SourceContext = {
  userId: 'user-1',
  orgId: 'org-1',
  tz: 'UTC',
  now: NOW,
  window: dayBounds('2026-09-16', 'UTC'),
}

function mockPrisma() {
  return {
    plannerItem: {
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  }
}

const empty: SourceRead = { items: [], resolveMissing: 'none' }
const readerOf = (read: SourceRead | null): SourceReader => vi.fn().mockResolvedValue(read)
const readers = (
  over: Partial<Record<'card' | 'email' | 'calendar' | 'slack', SourceReader>> = {}
) => ({
  card: readerOf(empty),
  email: readerOf(empty),
  calendar: readerOf(empty),
  slack: readerOf(empty),
  ...over,
})

describe('planner/collect — upserts', () => {
  let prisma: ReturnType<typeof mockPrisma>
  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('upserts each item by the (userId, sourceKey) compound key; create is open, update never touches user decisions', async () => {
    const cards: SourceRead = {
      items: [
        {
          sourceKey: 'card:c1',
          title: 'Ship it',
          summary: 'Demo Board · In Progress',
          url: '/board/b1?card=c1',
          priority: 'high',
          dueAt: new Date('2026-09-17T10:00:00Z'),
          payload: { cardId: 'c1', boardId: 'b1', role: 'assignee' },
        },
      ],
      resolveMissing: 'all',
    }
    const result = await collectForUser(CTX, {
      prisma,
      readers: readers({ card: readerOf(cards) }),
      now: () => NOW,
    })

    expect(prisma.plannerItem.upsert).toHaveBeenCalledTimes(1)
    const arg = prisma.plannerItem.upsert.mock.calls[0][0]
    expect(arg.where).toEqual({ userId_sourceKey: { userId: 'user-1', sourceKey: 'card:c1' } })
    expect(arg.create).toMatchObject({
      orgId: 'org-1',
      userId: 'user-1',
      source: 'card',
      sourceKey: 'card:c1',
      title: 'Ship it',
      summary: 'Demo Board · In Progress',
      url: '/board/b1?card=c1',
      priority: 'high',
      dueAt: new Date('2026-09-17T10:00:00Z'),
      status: 'open',
      lastSeenAt: NOW,
    })
    expect(JSON.parse(arg.create.payload)).toEqual({
      cardId: 'c1',
      boardId: 'b1',
      role: 'assignee',
    })
    expect(arg.update).toMatchObject({
      title: 'Ship it',
      url: '/board/b1?card=c1',
      priority: 'high',
      lastSeenAt: NOW,
    })
    for (const forbidden of [
      'status',
      'snoozedUntil',
      'resolvedBy',
      'resolvedAt',
      'prepNotes',
      'createdAt',
    ]) {
      expect(arg.update).not.toHaveProperty(forbidden)
    }
    expect(result.upserted).toBe(1)
    expect(result.status.card).toBe('ok')
  })

  it('defaults optional fields (summary/url/dueAt null, priority none, empty payload)', async () => {
    const read: SourceRead = {
      items: [{ sourceKey: 'slack:C1:1.0', title: 'hey', payload: {} }],
      resolveMissing: 'open',
    }
    await collectForUser(CTX, {
      prisma,
      readers: readers({ slack: readerOf(read) }),
      now: () => NOW,
    })
    const arg = prisma.plannerItem.upsert.mock.calls[0][0]
    expect(arg.create).toMatchObject({
      summary: null,
      url: null,
      priority: 'none',
      dueAt: null,
      startsAt: null,
      endsAt: null,
    })
    expect(arg.create.payload).toBe('{}')
  })

  it('drops unsafe urls and keeps app-relative card urls (safeItemUrl)', async () => {
    const read: SourceRead = {
      items: [
        { sourceKey: 'email:e1', title: 'a', url: 'javascript:alert(1)', payload: {} },
        { sourceKey: 'email:e2', title: 'b', url: '//evil.example/x', payload: {} },
        {
          sourceKey: 'email:e3',
          title: 'c',
          url: 'https://mail.google.com/mail/u/0/#inbox/t1',
          payload: {},
        },
      ],
      resolveMissing: 'all',
    }
    const cards: SourceRead = {
      items: [{ sourceKey: 'card:c9', title: 'd', url: '/board/b/?card=c9', payload: {} }],
      resolveMissing: 'all',
    }
    await collectForUser(CTX, {
      prisma,
      readers: readers({ email: readerOf(read), card: readerOf(cards) }),
      now: () => NOW,
    })
    const urls = Object.fromEntries(
      prisma.plannerItem.upsert.mock.calls.map((c) => [
        c[0].where.userId_sourceKey.sourceKey,
        c[0].create.url,
      ])
    )
    expect(urls).toEqual({
      'email:e1': null,
      'email:e2': null,
      'email:e3': 'https://mail.google.com/mail/u/0/#inbox/t1',
      'card:c9': '/board/b/?card=c9',
    })
  })

  it('skips items whose sourceKey does not carry the source prefix', async () => {
    const read: SourceRead = {
      items: [{ sourceKey: 'card:stray', title: 'x', payload: {} }],
      resolveMissing: 'none',
    }
    await collectForUser(CTX, {
      prisma,
      readers: readers({ email: readerOf(read) }),
      now: () => NOW,
    })
    expect(prisma.plannerItem.upsert).not.toHaveBeenCalled()
  })
})

describe('planner/collect — resolution modes', () => {
  let prisma: ReturnType<typeof mockPrisma>
  beforeEach(() => {
    prisma = mockPrisma()
  })

  function resolutionCalls() {
    return prisma.plannerItem.updateMany.mock.calls
      .map((c) => c[0])
      .filter((a) => a.data?.resolvedBy === 'source')
  }

  it("'all' resolves open AND snoozed rows not seen this run", async () => {
    prisma.plannerItem.updateMany.mockResolvedValue({ count: 2 })
    const res = await collectForUser(CTX, {
      prisma,
      readers: readers({ card: readerOf({ items: [], resolveMissing: 'all' }) }),
      now: () => NOW,
    })
    const [call] = resolutionCalls()
    expect(call.where).toEqual({
      userId: 'user-1',
      source: 'card',
      status: { in: ['open', 'snoozed'] },
      lastSeenAt: { lt: NOW },
    })
    expect(call.data).toEqual({ status: 'done', resolvedBy: 'source', resolvedAt: NOW })
    expect(res.resolved).toBe(2)
  })

  it("'open' resolves only open rows — a snoozed row is never resolved by absence", async () => {
    await collectForUser(CTX, {
      prisma,
      readers: readers({ slack: readerOf({ items: [], resolveMissing: 'open' }) }),
      now: () => NOW,
    })
    const [call] = resolutionCalls()
    expect(call.where).toEqual({
      userId: 'user-1',
      source: 'slack',
      status: 'open',
      lastSeenAt: { lt: NOW },
    })
  })

  it('a DayWindow resolves open + snoozed rows whose startsAt lies inside the window', async () => {
    const win = { start: new Date('2026-09-16T00:00:00Z'), end: new Date('2026-09-23T00:00:00Z') }
    await collectForUser(CTX, {
      prisma,
      readers: readers({ calendar: readerOf({ items: [], resolveMissing: win }) }),
      now: () => NOW,
    })
    const [call] = resolutionCalls()
    expect(call.where).toEqual({
      userId: 'user-1',
      source: 'calendar',
      status: { in: ['open', 'snoozed'] },
      lastSeenAt: { lt: NOW },
      startsAt: { gte: win.start, lt: win.end },
    })
  })

  it("'none' performs no resolution", async () => {
    await collectForUser(CTX, {
      prisma,
      readers: readers({ slack: readerOf({ items: [], resolveMissing: 'none' }) }),
      now: () => NOW,
    })
    expect(resolutionCalls()).toHaveLength(0)
  })

  it('resolution uses the run start as the lastSeenAt cutoff, and items upserted in this run are stamped at that instant', async () => {
    const read: SourceRead = {
      items: [{ sourceKey: 'card:c1', title: 'x', payload: {} }],
      resolveMissing: 'all',
    }
    await collectForUser(CTX, {
      prisma,
      readers: readers({ card: readerOf(read) }),
      now: () => NOW,
    })
    const upsert = prisma.plannerItem.upsert.mock.calls[0][0]
    const [resolve] = resolutionCalls()
    expect(upsert.update.lastSeenAt).toEqual(resolve.where.lastSeenAt.lt)
    // and the upsert happens before the resolution pass
    const upsertOrder = prisma.plannerItem.upsert.mock.invocationCallOrder[0]
    const resolveIndex = prisma.plannerItem.updateMany.mock.calls.findIndex(
      (c) => c[0].data?.resolvedBy === 'source'
    )
    const resolveOrder = prisma.plannerItem.updateMany.mock.invocationCallOrder[resolveIndex]
    expect(upsertOrder).toBeLessThan(resolveOrder)
  })
})

describe('planner/collect — source failures are isolated', () => {
  let prisma: ReturnType<typeof mockPrisma>
  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('a throwing reader → error status + message, no writes for that source, other sources unaffected', async () => {
    const boom: SourceReader = vi.fn().mockRejectedValue(new Error('slack down'))
    const cards: SourceRead = {
      items: [{ sourceKey: 'card:c1', title: 'x', payload: {} }],
      resolveMissing: 'all',
    }
    const res = await collectForUser(CTX, {
      prisma,
      readers: readers({ slack: boom, card: readerOf(cards) }),
      now: () => NOW,
    })
    expect(res.status.slack).toBe('error')
    expect(res.errors.slack).toBe('slack down')
    expect(res.status.card).toBe('ok')
    expect(prisma.plannerItem.upsert).toHaveBeenCalledTimes(1)
    const slackWrites = prisma.plannerItem.updateMany.mock.calls.filter(
      (c) => c[0].where?.source === 'slack'
    )
    expect(slackWrites).toHaveLength(0)
  })

  it('an InsufficientScopesError → needs_scope (not error)', async () => {
    const cal: SourceReader = vi
      .fn()
      .mockRejectedValue(
        new InsufficientScopesError(['https://www.googleapis.com/auth/calendar.events.readonly'])
      )
    const res = await collectForUser(CTX, {
      prisma,
      readers: readers({ calendar: cal }),
      now: () => NOW,
    })
    expect(res.status.calendar).toBe('needs_scope')
    expect(res.errors.calendar).toMatch(/calendar\.events\.readonly/)
  })

  it('a null read → skipped, no writes', async () => {
    const res = await collectForUser(CTX, {
      prisma,
      readers: readers({ email: readerOf(null) }),
      now: () => NOW,
    })
    expect(res.status.email).toBe('skipped')
    expect(res.errors.email).toBeUndefined()
    expect(prisma.plannerItem.upsert).not.toHaveBeenCalled()
  })

  it('error messages are truncated to 500 chars', async () => {
    const long: SourceReader = vi.fn().mockRejectedValue(new Error('x'.repeat(2000)))
    const res = await collectForUser(CTX, {
      prisma,
      readers: readers({ card: long }),
      now: () => NOW,
    })
    expect(res.errors.card).toHaveLength(500)
  })

  it('runs every reader even when one of them throws', async () => {
    const boom: SourceReader = vi.fn().mockRejectedValue(new Error('nope'))
    const r = readers({ card: boom })
    await collectForUser(CTX, { prisma, readers: r, now: () => NOW })
    for (const reader of Object.values(r)) expect(reader).toHaveBeenCalledWith(CTX)
  })
})

describe('planner/collect — calendar elapsed rule', () => {
  it('after an ok calendar read, meetings that ended are resolved as elapsed (open and snoozed)', async () => {
    const prisma = mockPrisma()
    await collectForUser(CTX, {
      prisma,
      readers: readers({ calendar: readerOf({ items: [], resolveMissing: 'none' }) }),
      now: () => NOW,
    })
    const elapsed = prisma.plannerItem.updateMany.mock.calls
      .map((c) => c[0])
      .find((a) => a.data?.resolvedBy === 'elapsed')
    expect(elapsed).toBeDefined()
    expect(elapsed.where).toEqual({
      userId: 'user-1',
      source: 'calendar',
      status: { in: ['open', 'snoozed'] },
      endsAt: { lt: NOW },
    })
    expect(elapsed.data).toEqual({ status: 'done', resolvedBy: 'elapsed', resolvedAt: NOW })
  })

  it('is not applied when the calendar read failed or was skipped', async () => {
    const prisma = mockPrisma()
    const failing: SourceReader = vi.fn().mockRejectedValue(new Error('x'))
    await collectForUser(CTX, { prisma, readers: readers({ calendar: failing }), now: () => NOW })
    await collectForUser(CTX, {
      prisma,
      readers: readers({ calendar: readerOf(null) }),
      now: () => NOW,
    })
    const elapsed = prisma.plannerItem.updateMany.mock.calls
      .map((c) => c[0])
      .filter((a) => a.data?.resolvedBy === 'elapsed')
    expect(elapsed).toHaveLength(0)
  })
})
