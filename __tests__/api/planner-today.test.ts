/**
 * GET /api/planner/today — spec §5.1 + §4.12: gates, validation, stale-vs-cached
 * collection, refresh rate limit, the two capped item queries, ranking, counts.
 * (WI-4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockRequireSession = vi.fn()
const mockRequireOrgRole = vi.fn()
vi.mock('../../src/lib/api-helpers', () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
  requireOrgRole: (...args: unknown[]) => mockRequireOrgRole(...args),
  apiError: (status: number, msg: string) => {
    const { NextResponse } = require('next/server')
    return NextResponse.json({ error: msg }, { status })
  },
}))

const mockPrisma = vi.hoisted(() => ({
  plannerDay: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  plannerItem: { findMany: vi.fn() },
}))
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const collect = vi.hoisted(() => ({ collectForUser: vi.fn() }))
vi.mock('../../src/lib/planner/collect', () => ({
  collectForUser: (...a: unknown[]) => collect.collectForUser(...a),
}))
vi.mock('../../src/lib/planner/sources/index', () => ({
  defaultReaders: () => ({ card: vi.fn(), email: vi.fn(), calendar: vi.fn(), slack: vi.fn() }),
}))

import { __resetRateLimitStore } from '../../src/lib/rate-limit'
import { dayBounds } from '../../src/lib/planner/time'

const HUMAN = { userId: 'user-1', orgId: 'org-1' }
const APIKEY = { userId: '', orgId: 'org-1', isApiKeyAuth: true, agentName: 'bot' }
const NOW = new Date('2026-09-16T09:00:00Z')
const MIN = 60_000

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/planner/today?${query}`, { method: 'GET' })
}

function day(over: Record<string, unknown> = {}) {
  return {
    id: 'day-1',
    orgId: 'org-1',
    userId: 'user-1',
    date: '2026-09-16',
    tz: 'UTC',
    brief: null,
    briefModel: null,
    briefAt: null,
    lastCollectedAt: null,
    collectStatus: '{}',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'it-1',
    orgId: 'org-1',
    userId: 'user-1',
    source: 'card',
    sourceKey: 'card:c1',
    title: 'Ship it',
    summary: null,
    url: '/board/b1?card=c1',
    priority: 'high',
    dueAt: null,
    startsAt: null,
    endsAt: null,
    status: 'open',
    snoozedUntil: null,
    resolvedBy: null,
    resolvedAt: null,
    prepNotes: null,
    payload: '{"cardId":"c1","boardId":"b1","role":"assignee"}',
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

const OK_COLLECT = {
  upserted: 3,
  resolved: 0,
  status: { card: 'ok', email: 'skipped', calendar: 'needs_scope', slack: 'error' },
  errors: { calendar: 'Missing scopes: calendar', slack: 'slack down' },
}

async function today(query = 'date=2026-09-16&tz=UTC') {
  const { GET } = await import('../../src/app/api/planner/today/route')
  const res = await GET(makeRequest(query))
  return { res, body: await res.json() }
}

function setItems(open: unknown[], resolved: unknown[]) {
  mockPrisma.plannerItem.findMany.mockImplementation(
    async (args: { where: { status: { in: string[] } } }) =>
      args.where.status.in.includes('open') ? open : resolved
  )
}

describe('GET /api/planner/today', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    __resetRateLimitStore()
    vi.stubEnv('PLANNER_COLLECT_STALE_MS', '')
    mockRequireSession.mockResolvedValue(HUMAN)
    mockRequireOrgRole.mockResolvedValue({ role: 'MEMBER' })
    const d = day()
    mockPrisma.plannerDay.findUnique.mockResolvedValue(d)
    mockPrisma.plannerDay.upsert.mockResolvedValue(d)
    mockPrisma.plannerDay.create.mockResolvedValue(d)
    mockPrisma.plannerDay.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({ ...d, ...args.data })
    )
    setItems([], [])
    collect.collectForUser.mockResolvedValue(OK_COLLECT)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('gates and validation', () => {
    it('401 when unauthenticated', async () => {
      mockRequireSession.mockRejectedValue(
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      )
      expect((await today()).res.status).toBe(401)
    })

    it('403 for an API-key session', async () => {
      mockRequireSession.mockResolvedValue(APIKEY)
      const { res, body } = await today()
      expect(res.status).toBe(403)
      expect(body.error).toBe('The planner requires a human session')
      expect(collect.collectForUser).not.toHaveBeenCalled()
    })

    it('requires MEMBER role', async () => {
      mockRequireOrgRole.mockRejectedValue(
        NextResponse.json(
          { error: 'Forbidden: not a member of this organization' },
          { status: 403 }
        )
      )
      expect((await today()).res.status).toBe(403)
      expect(mockRequireOrgRole).toHaveBeenCalledWith(HUMAN, 'org-1', 'MEMBER')
    })

    it('400 on a missing/invalid date or time zone', async () => {
      for (const q of [
        'tz=UTC',
        'date=16-09-2026&tz=UTC',
        'date=2026-02-30&tz=UTC',
        'date=2026-09-16',
        'date=2026-09-16&tz=Mars/Olympus',
      ]) {
        const { res, body } = await today(q)
        expect(res.status, q).toBe(400)
        expect(body.error).toBe('Validation failed')
      }
      expect(collect.collectForUser).not.toHaveBeenCalled()
    })
  })

  describe('collection', () => {
    it('collects on a day that has never been collected, then persists the status', async () => {
      const { res, body } = await today()
      expect(res.status).toBe(200)
      expect(collect.collectForUser).toHaveBeenCalledTimes(1)
      const [ctx, deps] = collect.collectForUser.mock.calls[0]
      expect(ctx).toEqual({
        userId: 'user-1',
        orgId: 'org-1',
        tz: 'UTC',
        now: NOW,
        window: dayBounds('2026-09-16', 'UTC'),
      })
      expect(deps.readers).toBeDefined()
      expect(deps.prisma).toBeDefined()

      const upd = mockPrisma.plannerDay.update.mock.calls
        .map((c) => c[0])
        .find((a) => a.data.lastCollectedAt)
      expect(upd.data.lastCollectedAt).toEqual(NOW)
      expect(JSON.parse(upd.data.collectStatus)).toEqual({
        ...OK_COLLECT.status,
        errors: OK_COLLECT.errors,
      })

      expect(body.collectedAt).toBe(NOW.toISOString())
      expect(body.sources).toEqual(OK_COLLECT.status)
      expect(body.sourceErrors).toEqual(OK_COLLECT.errors)
    })

    it('does not collect again within the stale window, and reports the stored status', async () => {
      const stored = day({
        lastCollectedAt: new Date(NOW.getTime() - 2 * MIN),
        collectStatus: JSON.stringify({
          card: 'ok',
          email: 'skipped',
          calendar: 'skipped',
          slack: 'skipped',
          errors: {},
        }),
      })
      mockPrisma.plannerDay.findUnique.mockResolvedValue(stored)
      mockPrisma.plannerDay.upsert.mockResolvedValue(stored)
      const { body } = await today()
      expect(collect.collectForUser).not.toHaveBeenCalled()
      expect(body.collectedAt).toBe(new Date(NOW.getTime() - 2 * MIN).toISOString())
      expect(body.sources).toEqual({
        card: 'ok',
        email: 'skipped',
        calendar: 'skipped',
        slack: 'skipped',
      })
      expect(body.sourceErrors).toEqual({})
    })

    it('collects again once the last collection is older than PLANNER_COLLECT_STALE_MS (default 5 min)', async () => {
      const stale = day({ lastCollectedAt: new Date(NOW.getTime() - 6 * MIN) })
      mockPrisma.plannerDay.findUnique.mockResolvedValue(stale)
      mockPrisma.plannerDay.upsert.mockResolvedValue(stale)
      await today()
      expect(collect.collectForUser).toHaveBeenCalledTimes(1)

      vi.stubEnv('PLANNER_COLLECT_STALE_MS', String(10 * MIN))
      collect.collectForUser.mockClear()
      await today()
      expect(collect.collectForUser).not.toHaveBeenCalled()
    })

    it('refresh=1 forces a collection and is limited to 6 per minute', async () => {
      const fresh = day({ lastCollectedAt: new Date(NOW.getTime() - 10_000) })
      mockPrisma.plannerDay.findUnique.mockResolvedValue(fresh)
      mockPrisma.plannerDay.upsert.mockResolvedValue(fresh)
      for (let i = 0; i < 6; i++) {
        expect((await today('date=2026-09-16&tz=UTC&refresh=1')).res.status).toBe(200)
      }
      expect(collect.collectForUser).toHaveBeenCalledTimes(6)
      const { res, body } = await today('date=2026-09-16&tz=UTC&refresh=1')
      expect(res.status).toBe(429)
      expect(body.error).toBe('Too many refreshes. Try again in a minute.')
      // the unforced path is never limited
      expect((await today()).res.status).toBe(200)
    })
  })

  describe('response', () => {
    it('reads open/snoozed and today-resolved items with two capped queries and returns ranked items with sections', async () => {
      const win = dayBounds('2026-09-16', 'UTC')
      const open = [
        row({
          id: 'a',
          sourceKey: 'card:a',
          priority: 'critical',
          dueAt: new Date(NOW.getTime() - 86_400_000),
        }),
        row({ id: 'b', sourceKey: 'card:b', priority: 'none' }),
        row({
          id: 'c',
          sourceKey: 'calendar:c',
          source: 'calendar',
          startsAt: new Date(NOW.getTime() + 30 * MIN),
          endsAt: new Date(NOW.getTime() + 60 * MIN),
          payload: '{"eventId":"c","allDay":false}',
        }),
        row({
          id: 'd',
          sourceKey: 'email:d',
          source: 'email',
          payload: '{"cardId":"x","urgent":true}',
        }),
        row({ id: 'e', sourceKey: 'slack:C:1', source: 'slack', payload: '{"kind":"dm"}' }),
        row({
          id: 'f',
          sourceKey: 'manual:f',
          source: 'manual',
          status: 'snoozed',
          snoozedUntil: new Date(NOW.getTime() + 60 * MIN),
        }),
      ]
      const resolved = [
        row({ id: 'g', sourceKey: 'card:g', status: 'done', resolvedBy: 'user', resolvedAt: NOW }),
        row({
          id: 'h',
          sourceKey: 'card:h',
          status: 'dismissed',
          resolvedBy: 'user',
          resolvedAt: NOW,
        }),
      ]
      setItems(open, resolved)
      const { res, body } = await today()
      expect(res.status).toBe(200)

      const [q1, q2] = mockPrisma.plannerItem.findMany.mock.calls.map((c) => c[0])
      expect(q1).toMatchObject({
        where: { userId: 'user-1', orgId: 'org-1', status: { in: ['open', 'snoozed'] } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
      expect(q2).toMatchObject({
        where: {
          userId: 'user-1',
          orgId: 'org-1',
          status: { in: ['done', 'dismissed', 'wont_do'] },
          resolvedAt: { gte: win.start },
        },
        orderBy: { resolvedAt: 'desc' },
        take: 200,
      })

      expect(body.date).toBe('2026-09-16')
      expect(body.tz).toBe('UTC')
      expect(body.window).toEqual({ start: win.start.toISOString(), end: win.end.toISOString() })
      expect(body.truncated).toBe(false)
      expect(body.brief).toBeNull()

      const byId = Object.fromEntries(body.items.map((i: { id: string }) => [i.id, i]))
      expect(Object.keys(byId).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
      expect(byId.a.section).toBe('now') // overdue critical: 42 + 25
      expect(byId.c.section).toBe('now') // meeting in 30m: 50
      expect(byId.d.section).toBe('now') // urgent email: 30
      expect(byId.e.section).toBe('today') // slack dm 12
      expect(byId.b.section).toBe('later')
      expect(byId.f.section).toBe('snoozed')
      expect(byId.g.section).toBe('done')
      expect(byId.h.section).toBe('dismissed')
      expect(byId.a.reasons).toEqual(['overdue 1d', 'critical'])
      expect(byId.a.payload).toEqual({ cardId: 'c1', boardId: 'b1', role: 'assignee' })
      // ranked order: score desc
      expect(body.items.slice(0, 3).map((i: { id: string }) => i.id)).toEqual(['a', 'c', 'd'])

      expect(body.counts).toEqual({
        now: 3,
        open: 5,
        overdue: 1,
        meetingsToday: 1,
        inbox: 1,
        slack: 1,
        doneToday: 1,
        dismissed: 1,
      })
    })

    it('reports truncated when a query hits its cap, and excludes all-day events from meetingsToday', async () => {
      const open = Array.from({ length: 500 }, (_, i) =>
        row({ id: `o${i}`, sourceKey: `card:o${i}` })
      )
      open[0] = row({
        id: 'o0',
        sourceKey: 'calendar:o0',
        source: 'calendar',
        startsAt: new Date(NOW.getTime() - 9 * 60 * MIN),
        endsAt: new Date(NOW.getTime() + 15 * 60 * MIN),
        payload: '{"eventId":"o0","allDay":true}',
      })
      setItems(open, [])
      const { body } = await today()
      expect(body.truncated).toBe(true)
      expect(body.counts.meetingsToday).toBe(0)
    })

    it('returns the stored brief', async () => {
      const withBrief = day({
        brief: '# Today\n- one',
        briefModel: 'claude-sonnet-4-6',
        briefAt: NOW,
        lastCollectedAt: NOW,
      })
      mockPrisma.plannerDay.findUnique.mockResolvedValue(withBrief)
      mockPrisma.plannerDay.upsert.mockResolvedValue(withBrief)
      const { body } = await today()
      expect(body.brief).toEqual({
        text: '# Today\n- one',
        model: 'claude-sonnet-4-6',
        at: NOW.toISOString(),
      })
    })

    it('creates/gets the day row keyed by (userId, date) and records the tz', async () => {
      await today('date=2026-09-17&tz=Europe/London')
      const creates = [
        ...mockPrisma.plannerDay.upsert.mock.calls,
        ...mockPrisma.plannerDay.create.mock.calls,
      ].map((c) => c[0])
      expect(creates.length).toBeGreaterThan(0)
      const create = creates[0].create ?? creates[0].data
      expect(create).toMatchObject({
        userId: 'user-1',
        orgId: 'org-1',
        date: '2026-09-17',
        tz: 'Europe/London',
      })
    })
  })
})
