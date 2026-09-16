/**
 * POST /api/planner/items, PATCH/DELETE /api/planner/items/[id] — spec §5.2–§5.4.
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
  plannerItem: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
}))
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const wt = vi.hoisted(() => ({ applyWriteThrough: vi.fn() }))
vi.mock('../../src/lib/planner/write-through', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/planner/write-through')>()
  return { ...actual, applyWriteThrough: (...a: unknown[]) => wt.applyWriteThrough(...a) }
})

const HUMAN = { userId: 'user-1', orgId: 'org-1' }
const APIKEY = { userId: '', orgId: 'org-1', isApiKeyAuth: true, agentName: 'bot' }
const NOW = new Date('2026-09-16T09:00:00Z')

function json(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    payload: '{"cardId":"c1","boardId":"b1","role":"assignee"}',
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

const ctx = { params: Promise.resolve({ id: 'it-1' }) }

describe('POST /api/planner/items (quick add)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mockRequireSession.mockResolvedValue(HUMAN)
    mockRequireOrgRole.mockResolvedValue({ role: 'MEMBER' })
    mockPrisma.plannerItem.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) => row({ ...args.data, id: 'new-1' })
    )
  })
  afterEach(() => vi.useRealTimers())

  it('403 for an API key, 401 when unauthenticated', async () => {
    const { POST } = await import('../../src/app/api/planner/items/route')
    mockRequireSession.mockResolvedValue(APIKEY)
    expect(
      (await POST(json('http://localhost/api/planner/items', 'POST', { title: 'x' }))).status
    ).toBe(403)
    mockRequireSession.mockRejectedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
    expect(
      (await POST(json('http://localhost/api/planner/items', 'POST', { title: 'x' }))).status
    ).toBe(401)
  })

  it('validates the body', async () => {
    const { POST } = await import('../../src/app/api/planner/items/route')
    for (const body of [
      {},
      { title: '' },
      { title: 'x'.repeat(501) },
      { title: 'ok', dueAt: 'tomorrow' },
      { title: 'ok', priority: 'urgent' },
      { title: 'ok', summary: 'x'.repeat(2001) },
    ]) {
      const res = await POST(json('http://localhost/api/planner/items', 'POST', body))
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error).toBe('Validation failed')
    }
    expect(mockPrisma.plannerItem.create).not.toHaveBeenCalled()
  })

  it('creates an open manual item owned by the caller and returns the DTO (201)', async () => {
    const { POST } = await import('../../src/app/api/planner/items/route')
    const res = await POST(
      json('http://localhost/api/planner/items', 'POST', {
        title: 'Call the bank',
        summary: 'about the wire',
        dueAt: '2026-09-16T15:00:00+01:00',
        priority: 'high',
      })
    )
    expect(res.status).toBe(201)
    const data = mockPrisma.plannerItem.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      orgId: 'org-1',
      userId: 'user-1',
      source: 'manual',
      title: 'Call the bank',
      summary: 'about the wire',
      priority: 'high',
      status: 'open',
      payload: '{}',
    })
    expect(data.sourceKey).toMatch(/^manual:[A-Za-z0-9_-]{10,}$/)
    expect(data.dueAt).toEqual(new Date('2026-09-16T14:00:00Z'))
    const body = await res.json()
    expect(body.item).toMatchObject({
      id: 'new-1',
      source: 'manual',
      title: 'Call the bank',
      status: 'open',
      priority: 'high',
      payload: {},
    })
    expect(body.item).not.toHaveProperty('userId')
  })

  it('defaults priority to none and leaves dueAt null', async () => {
    const { POST } = await import('../../src/app/api/planner/items/route')
    await POST(json('http://localhost/api/planner/items', 'POST', { title: 'Just this' }))
    expect(mockPrisma.plannerItem.create.mock.calls[0][0].data).toMatchObject({
      priority: 'none',
      dueAt: null,
      summary: null,
    })
  })
})

describe('PATCH /api/planner/items/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mockRequireSession.mockResolvedValue(HUMAN)
    mockRequireOrgRole.mockResolvedValue({ role: 'MEMBER' })
    mockPrisma.plannerItem.findFirst.mockResolvedValue(row())
    mockPrisma.plannerItem.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) => row(args.data)
    )
    wt.applyWriteThrough.mockResolvedValue([{ kind: 'none', ok: true, reason: 'not_applicable' }])
  })
  afterEach(() => vi.useRealTimers())

  async function patch(body: unknown) {
    const { PATCH } = await import('../../src/app/api/planner/items/[id]/route')
    const res = await PATCH(json('http://localhost/api/planner/items/it-1', 'PATCH', body), ctx)
    return { res, body: await res.json() }
  }

  it('403 for API keys, 404 for an item the caller does not own (never 403)', async () => {
    mockRequireSession.mockResolvedValue(APIKEY)
    expect((await patch({ action: 'done' })).res.status).toBe(403)

    mockRequireSession.mockResolvedValue(HUMAN)
    mockPrisma.plannerItem.findFirst.mockResolvedValue(null)
    const { res, body } = await patch({ action: 'done' })
    expect(res.status).toBe(404)
    expect(body.error).toBe('Item not found')
    expect(mockPrisma.plannerItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'it-1', userId: 'user-1' }) })
    )
    expect(mockPrisma.plannerItem.update).not.toHaveBeenCalled()
  })

  it('validates the action and snooze payload', async () => {
    expect((await patch({ action: 'complete' })).res.status).toBe(400)
    expect((await patch({})).res.status).toBe(400)
    expect((await patch({ action: 'snooze' })).res.status).toBe(400)
    expect((await patch({ action: 'snooze', snoozedUntil: 'later' })).res.status).toBe(400)
    expect(
      (
        await patch({
          action: 'snooze',
          snoozedUntil: new Date(NOW.getTime() - 1000).toISOString(),
        })
      ).res.status
    ).toBe(400)
    expect(mockPrisma.plannerItem.update).not.toHaveBeenCalled()
  })

  it.each([
    ['done', { status: 'done', resolvedBy: 'user', resolvedAt: NOW, snoozedUntil: null }],
    ['dismiss', { status: 'dismissed', resolvedBy: 'user', resolvedAt: NOW, snoozedUntil: null }],
    ['wont_do', { status: 'wont_do', resolvedBy: 'user', resolvedAt: NOW, snoozedUntil: null }],
    ['reopen', { status: 'open', snoozedUntil: null, resolvedBy: null, resolvedAt: null }],
  ])(
    '%s updates the item fields and returns the DTO with write-through results',
    async (action, expected) => {
      const { res, body } = await patch({ action })
      expect(res.status).toBe(200)
      const upd = mockPrisma.plannerItem.update.mock.calls[0][0]
      expect(upd.where).toEqual({ id: 'it-1' })
      expect(upd.data).toEqual(expected)
      expect(body.item.status).toBe(expected.status)
      expect(body.writeThrough).toEqual([{ kind: 'none', ok: true, reason: 'not_applicable' }])
    }
  )

  it('snooze stores the future snoozedUntil and clears resolution', async () => {
    const until = new Date(NOW.getTime() + 3 * 3600_000).toISOString()
    const { res } = await patch({ action: 'snooze', snoozedUntil: until })
    expect(res.status).toBe(200)
    expect(mockPrisma.plannerItem.update.mock.calls[0][0].data).toEqual({
      status: 'snoozed',
      snoozedUntil: new Date(until),
      resolvedBy: null,
      resolvedAt: null,
    })
  })

  it('runs write-through after the status change with the session, and passes failures through on a 200', async () => {
    wt.applyWriteThrough.mockResolvedValue([{ kind: 'card_moved', ok: false, error: 'db locked' }])
    const { res, body } = await patch({ action: 'done' })
    expect(res.status).toBe(200)
    expect(body.item.status).toBe('done')
    expect(body.writeThrough).toEqual([{ kind: 'card_moved', ok: false, error: 'db locked' }])
    const args = wt.applyWriteThrough.mock.calls[0][0]
    expect(args.action).toBe('done')
    expect(args.session).toEqual(HUMAN)
    expect(args.item).toMatchObject({
      id: 'it-1',
      source: 'card',
      payload: { cardId: 'c1', boardId: 'b1', role: 'assignee' },
    })
    expect(mockPrisma.plannerItem.update.mock.invocationCallOrder[0]).toBeLessThan(
      wt.applyWriteThrough.mock.invocationCallOrder[0]
    )
  })

  it('writeThrough:false skips side effects entirely', async () => {
    const { body } = await patch({ action: 'done', writeThrough: false })
    expect(wt.applyWriteThrough).not.toHaveBeenCalled()
    expect(body.writeThrough).toEqual([])
  })
})

describe('DELETE /api/planner/items/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireSession.mockResolvedValue(HUMAN)
    mockRequireOrgRole.mockResolvedValue({ role: 'MEMBER' })
    mockPrisma.plannerItem.delete.mockResolvedValue({})
  })

  async function del() {
    const { DELETE } = await import('../../src/app/api/planner/items/[id]/route')
    return DELETE(json('http://localhost/api/planner/items/it-1', 'DELETE'), ctx)
  }

  it('deletes a manual item (204)', async () => {
    mockPrisma.plannerItem.findFirst.mockResolvedValue(
      row({ source: 'manual', sourceKey: 'manual:abc' })
    )
    const res = await del()
    expect(res.status).toBe(204)
    expect(mockPrisma.plannerItem.delete).toHaveBeenCalledWith({ where: { id: 'it-1' } })
  })

  it('refuses to delete a sourced item (400) and hides foreign items (404)', async () => {
    mockPrisma.plannerItem.findFirst.mockResolvedValue(row({ source: 'email' }))
    const res = await del()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Only your own to-dos can be deleted; dismiss instead')
    expect(mockPrisma.plannerItem.delete).not.toHaveBeenCalled()

    mockPrisma.plannerItem.findFirst.mockResolvedValue(null)
    expect((await del()).status).toBe(404)
  })

  it('403 for API keys', async () => {
    mockRequireSession.mockResolvedValue(APIKEY)
    expect((await del()).status).toBe(403)
  })
})
