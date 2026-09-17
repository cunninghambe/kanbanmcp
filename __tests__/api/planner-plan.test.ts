/**
 * POST /api/planner/plan — spec §5.5: the one attended "plan my day" model call.
 * Rate limited, ownership-scoped prepNotes writes, brief persisted. (WI-4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

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
  plannerItem: { findMany: vi.fn(), updateMany: vi.fn() },
  user: { findUnique: vi.fn() },
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
import { PlannerLlmUnconfiguredError, __setPlannerLlmForTests } from '../../src/lib/planner/llm'

const HUMAN = { userId: 'user-1', orgId: 'org-1' }
const APIKEY = { userId: '', orgId: 'org-1', isApiKeyAuth: true, agentName: 'bot' }
const NOW = new Date('2026-09-16T09:00:00Z')

function req(body: unknown = { date: '2026-09-16', tz: 'UTC' }): NextRequest {
  return new NextRequest('http://localhost/api/planner/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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
    url: null,
    priority: 'high',
    dueAt: null,
    startsAt: null,
    endsAt: null,
    status: 'open',
    snoozedUntil: null,
    resolvedBy: null,
    resolvedAt: null,
    prepNotes: null,
    payload: '{}',
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

const DAY = {
  id: 'day-1',
  orgId: 'org-1',
  userId: 'user-1',
  date: '2026-09-16',
  tz: 'UTC',
  brief: null,
  briefModel: null,
  briefAt: null,
  lastCollectedAt: NOW,
  collectStatus: '{}',
  createdAt: NOW,
  updatedAt: NOW,
}

describe('POST /api/planner/plan', () => {
  const llm = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    __resetRateLimitStore()
    __setPlannerLlmForTests(llm)
    mockRequireSession.mockResolvedValue(HUMAN)
    mockRequireOrgRole.mockResolvedValue({ role: 'MEMBER' })
    mockPrisma.plannerDay.findUnique.mockResolvedValue(DAY)
    mockPrisma.plannerDay.upsert.mockResolvedValue(DAY)
    mockPrisma.plannerDay.create.mockResolvedValue(DAY)
    mockPrisma.plannerDay.update.mockImplementation(
      async (a: { data: Record<string, unknown> }) => ({ ...DAY, ...a.data })
    )
    mockPrisma.plannerItem.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.user.findUnique.mockResolvedValue({
      name: 'Beth Cunningham',
      email: 'beth@example.com',
    })
    mockPrisma.plannerItem.findMany.mockImplementation(
      async (args: { where: { status: { in: string[] } } }) =>
        args.where.status.in.includes('open')
          ? [
              row({
                id: 'it-1',
                priority: 'critical',
                dueAt: new Date(NOW.getTime() - 86_400_000),
              }),
              row({
                id: 'it-2',
                sourceKey: 'email:e',
                source: 'email',
                payload: '{"urgent":true}',
              }),
              row({
                id: 'cal-1',
                sourceKey: 'calendar:x',
                source: 'calendar',
                startsAt: new Date(NOW.getTime() + 5 * 3600_000),
                endsAt: new Date(NOW.getTime() + 6 * 3600_000),
                payload: '{"allDay":false}',
              }),
            ]
          : []
    )
    llm.mockResolvedValue({
      text: '```json\n{"brief":"# Today\\n- Reply to Jane first","items":[{"id":"it-1","prepNotes":"Check the numbers"},{"id":"cal-1","prepNotes":"Bring the deck"},{"id":"not-mine","prepNotes":"x"}]}\n```',
      model: 'claude-sonnet-4-6',
      inputTokens: 900,
      outputTokens: 210,
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    __setPlannerLlmForTests(null)
  })

  async function plan(body?: unknown) {
    const { POST } = await import('../../src/app/api/planner/plan/route')
    const res = await POST(req(body))
    return { res, body: await res.json() }
  }

  it('403 for API keys, 400 on validation', async () => {
    mockRequireSession.mockResolvedValue(APIKEY)
    expect((await plan()).res.status).toBe(403)
    mockRequireSession.mockResolvedValue(HUMAN)
    expect((await plan({ date: 'nope', tz: 'UTC' })).res.status).toBe(400)
    expect((await plan({ date: '2026-09-16', tz: 'Nope/Zone' })).res.status).toBe(400)
    expect(llm).not.toHaveBeenCalled()
  })

  it("calls the model once with the ranked items and today's meetings, persists prepNotes (owner-scoped) and the brief", async () => {
    const { res, body } = await plan()
    expect(res.status).toBe(200)
    expect(llm).toHaveBeenCalledTimes(1)
    const call = llm.mock.calls[0][0]
    expect(call.maxTokens).toBe(1500)
    expect(call.orgId).toBe('org-1')
    expect(call.user).toContain('it-1')
    expect(call.user).toContain('it-2')
    expect(call.user).toContain('cal-1')
    expect(call.user).toContain('Beth Cunningham')

    const notes = mockPrisma.plannerItem.updateMany.mock.calls.map((c) => c[0])
    expect(notes).toEqual(
      expect.arrayContaining([
        { where: { id: 'it-1', userId: 'user-1' }, data: { prepNotes: 'Check the numbers' } },
        { where: { id: 'cal-1', userId: 'user-1' }, data: { prepNotes: 'Bring the deck' } },
        { where: { id: 'not-mine', userId: 'user-1' }, data: { prepNotes: 'x' } },
      ])
    )
    const dayUpd = mockPrisma.plannerDay.update.mock.calls
      .map((c) => c[0])
      .find((a) => a.data.brief)
    expect(dayUpd.data).toEqual({
      brief: '# Today\n- Reply to Jane first',
      briefModel: 'claude-sonnet-4-6',
      briefAt: NOW,
    })

    expect(body).toEqual({
      brief: '# Today\n- Reply to Jane first',
      model: 'claude-sonnet-4-6',
      updatedItems: 3,
      inputTokens: 900,
      outputTokens: 210,
    })
  })

  it('collects first when the day is stale, never when it is fresh', async () => {
    collect.collectForUser.mockResolvedValue({
      upserted: 0,
      resolved: 0,
      status: { card: 'ok', email: 'skipped', calendar: 'skipped', slack: 'skipped' },
      errors: {},
    })
    await plan()
    expect(collect.collectForUser).not.toHaveBeenCalled()
    const stale = { ...DAY, lastCollectedAt: new Date(NOW.getTime() - 10 * 60_000) }
    mockPrisma.plannerDay.findUnique.mockResolvedValue(stale)
    mockPrisma.plannerDay.upsert.mockResolvedValue(stale)
    await plan()
    expect(collect.collectForUser).toHaveBeenCalledTimes(1)
  })

  it("sends at most 12 task items plus the day's meetings", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      row({ id: `task-${i}`, sourceKey: `card:t${i}`, priority: 'high' })
    )
    many.push(
      row({
        id: 'meet-1',
        sourceKey: 'calendar:m',
        source: 'calendar',
        startsAt: new Date(NOW.getTime() + 3600_000),
        endsAt: new Date(NOW.getTime() + 7200_000),
        payload: '{"allDay":false}',
      })
    )
    mockPrisma.plannerItem.findMany.mockImplementation(
      async (args: { where: { status: { in: string[] } } }) =>
        args.where.status.in.includes('open') ? many : []
    )
    await plan()
    const user: string = llm.mock.calls[0][0].user
    const taskIds = (user.match(/task-\d+/g) ?? []).filter((v, i, a) => a.indexOf(v) === i)
    expect(taskIds.length).toBeLessThanOrEqual(12)
    expect(user).toContain('meet-1')
  })

  it('is limited to 3 runs per 10 minutes', async () => {
    for (let i = 0; i < 3; i++) expect((await plan()).res.status).toBe(200)
    const { res, body } = await plan()
    expect(res.status).toBe(429)
    expect(body.error).toBe('Plan my day is limited to 3 runs per 10 minutes')
    expect(llm).toHaveBeenCalledTimes(3)
  })

  it('503 when no AI backend is configured, 502 when the model call fails', async () => {
    llm.mockRejectedValue(new PlannerLlmUnconfiguredError('none'))
    const a = await plan()
    expect(a.res.status).toBe(503)
    expect(a.body.error).toBe('No AI backend configured')

    llm.mockRejectedValue(new Error('overloaded'))
    const b = await plan()
    expect(b.res.status).toBe(502)
    expect(b.body.error).toBe('Plan generation failed')
    expect(
      mockPrisma.plannerDay.update.mock.calls.map((c) => c[0]).find((x) => x.data.brief)
    ).toBeUndefined()
  })

  it('a prose-only answer still becomes the brief with zero item updates', async () => {
    llm.mockResolvedValue({
      text: 'Focus on Jane, then the deck.',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
    })
    const { body } = await plan()
    expect(body.brief).toBe('Focus on Jane, then the deck.')
    expect(body.updatedItems).toBe(0)
    expect(mockPrisma.plannerItem.updateMany).not.toHaveBeenCalled()
  })
})
