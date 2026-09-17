/**
 * Drafts CRUD and the attended "ask claude" generate — spec §5.6 (WI-4).
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
  plannerDraft: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  plannerItem: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
}))
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

import { __resetRateLimitStore } from '../../src/lib/rate-limit'
import { PlannerLlmUnconfiguredError, __setPlannerLlmForTests } from '../../src/lib/planner/llm'

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

function draft(over: Record<string, unknown> = {}) {
  return {
    id: 'd-1',
    orgId: 'org-1',
    userId: 'user-1',
    itemId: 'it-1',
    title: 'Re: Jane',
    body: 'Hi Jane',
    status: 'draft',
    handoff: null,
    pendingEmail: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function itemRow(over: Record<string, unknown> = {}) {
  return {
    id: 'it-1',
    orgId: 'org-1',
    userId: 'user-1',
    source: 'email',
    sourceKey: 'email:e1',
    title: 'Reply to Jane',
    summary: 'Jane <jane@example.com>',
    url: null,
    priority: 'medium',
    dueAt: null,
    startsAt: null,
    endsAt: null,
    status: 'open',
    snoozedUntil: null,
    resolvedBy: null,
    resolvedAt: null,
    prepNotes: null,
    payload: '{"cardId":"c1","gmailThreadId":"t1","from":"Jane <jane@example.com>"}',
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

const ctx = { params: Promise.resolve({ id: 'd-1' }) }

describe('/api/planner/drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    __resetRateLimitStore()
    mockRequireSession.mockResolvedValue(HUMAN)
    mockRequireOrgRole.mockResolvedValue({ role: 'MEMBER' })
    mockPrisma.plannerDraft.findMany.mockResolvedValue([
      draft(),
      draft({ id: 'd-2', itemId: null }),
    ])
    mockPrisma.plannerDraft.findFirst.mockResolvedValue(draft())
    mockPrisma.plannerDraft.create.mockImplementation(
      async (a: { data: Record<string, unknown> }) => draft({ ...a.data, id: 'd-new' })
    )
    mockPrisma.plannerDraft.update.mockImplementation(
      async (a: { data: Record<string, unknown> }) => draft(a.data)
    )
    mockPrisma.plannerDraft.delete.mockResolvedValue({})
    mockPrisma.plannerItem.findFirst.mockResolvedValue(itemRow())
    mockPrisma.user.findUnique.mockResolvedValue({ name: 'Beth', email: 'beth@example.com' })
  })
  afterEach(() => {
    vi.useRealTimers()
    __setPlannerLlmForTests(null)
  })

  describe('GET', () => {
    it("lists the caller's drafts newest first (optionally for one item)", async () => {
      const { GET } = await import('../../src/app/api/planner/drafts/route')
      const res = await GET(json('http://localhost/api/planner/drafts?itemId=it-1', 'GET'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.drafts).toHaveLength(2)
      expect(body.drafts[0]).toMatchObject({
        id: 'd-1',
        title: 'Re: Jane',
        status: 'draft',
        handoff: null,
        pendingEmail: null,
      })
      expect(body.drafts[0]).not.toHaveProperty('userId')
      const q = mockPrisma.plannerDraft.findMany.mock.calls[0][0]
      expect(q.where).toEqual({ userId: 'user-1', orgId: 'org-1', itemId: 'it-1' })
      expect(q.orderBy).toEqual({ createdAt: 'desc' })
      expect(q.take).toBe(50)

      await GET(json('http://localhost/api/planner/drafts', 'GET'))
      expect(mockPrisma.plannerDraft.findMany.mock.calls[1][0].where).toEqual({
        userId: 'user-1',
        orgId: 'org-1',
      })
    })

    it('403 for API keys', async () => {
      mockRequireSession.mockResolvedValue(APIKEY)
      const { GET } = await import('../../src/app/api/planner/drafts/route')
      expect((await GET(json('http://localhost/api/planner/drafts', 'GET'))).status).toBe(403)
    })
  })

  describe('POST', () => {
    it('creates a draft (201), checking item ownership when itemId is given', async () => {
      const { POST } = await import('../../src/app/api/planner/drafts/route')
      const res = await POST(
        json('http://localhost/api/planner/drafts', 'POST', {
          itemId: 'it-1',
          title: 'Re: Jane',
          body: 'Hi',
        })
      )
      expect(res.status).toBe(201)
      expect(mockPrisma.plannerItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'it-1', userId: 'user-1' }),
        })
      )
      expect(mockPrisma.plannerDraft.create.mock.calls[0][0].data).toMatchObject({
        orgId: 'org-1',
        userId: 'user-1',
        itemId: 'it-1',
        title: 'Re: Jane',
        body: 'Hi',
        status: 'draft',
      })
      expect((await res.json()).draft).toMatchObject({ id: 'd-new', title: 'Re: Jane', body: 'Hi' })
    })

    it("404 when the item is not the caller's; validates title/body", async () => {
      const { POST } = await import('../../src/app/api/planner/drafts/route')
      mockPrisma.plannerItem.findFirst.mockResolvedValue(null)
      const res = await POST(
        json('http://localhost/api/planner/drafts', 'POST', { itemId: 'other', title: 'x' })
      )
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe('Item not found')
      expect(
        (await POST(json('http://localhost/api/planner/drafts', 'POST', { title: '' }))).status
      ).toBe(400)
      expect(
        (
          await POST(
            json('http://localhost/api/planner/drafts', 'POST', { title: 'x'.repeat(301) })
          )
        ).status
      ).toBe(400)
      expect(
        (
          await POST(
            json('http://localhost/api/planner/drafts', 'POST', {
              title: 'ok',
              body: 'x'.repeat(50_001),
            })
          )
        ).status
      ).toBe(400)
    })

    it('a free-standing draft needs no item', async () => {
      const { POST } = await import('../../src/app/api/planner/drafts/route')
      expect(
        (await POST(json('http://localhost/api/planner/drafts', 'POST', { title: 'Notes' }))).status
      ).toBe(201)
      expect(mockPrisma.plannerItem.findFirst).not.toHaveBeenCalled()
      expect(mockPrisma.plannerDraft.create.mock.calls[0][0].data).toMatchObject({
        itemId: null,
        body: '',
      })
    })
  })

  describe('PATCH', () => {
    it('updates title/body, clears pendingEmail on any edit, and hides foreign drafts', async () => {
      const { PATCH } = await import('../../src/app/api/planner/drafts/[id]/route')
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(
        draft({ pendingEmail: '{"gmailDraftId":"g1"}' })
      )
      const res = await PATCH(
        json('http://localhost/api/planner/drafts/d-1', 'PATCH', { body: 'Hi Jane, edited' }),
        ctx
      )
      expect(res.status).toBe(200)
      expect(mockPrisma.plannerDraft.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'd-1', userId: 'user-1' }) })
      )
      expect(mockPrisma.plannerDraft.update.mock.calls[0][0]).toEqual({
        where: { id: 'd-1' },
        data: { body: 'Hi Jane, edited', pendingEmail: null },
      })

      mockPrisma.plannerDraft.findFirst.mockResolvedValue(null)
      expect(
        (await PATCH(json('http://localhost/api/planner/drafts/d-1', 'PATCH', { title: 'x' }), ctx))
          .status
      ).toBe(404)
    })

    it('400 on an empty body object', async () => {
      const { PATCH } = await import('../../src/app/api/planner/drafts/[id]/route')
      expect(
        (await PATCH(json('http://localhost/api/planner/drafts/d-1', 'PATCH', {}), ctx)).status
      ).toBe(400)
    })
  })

  describe('DELETE', () => {
    it('204 for own draft, 404 otherwise', async () => {
      const { DELETE } = await import('../../src/app/api/planner/drafts/[id]/route')
      expect(
        (await DELETE(json('http://localhost/api/planner/drafts/d-1', 'DELETE'), ctx)).status
      ).toBe(204)
      expect(mockPrisma.plannerDraft.delete).toHaveBeenCalledWith({ where: { id: 'd-1' } })
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(null)
      expect(
        (await DELETE(json('http://localhost/api/planner/drafts/d-1', 'DELETE'), ctx)).status
      ).toBe(404)
    })
  })

  describe('POST /generate', () => {
    const llm = vi.fn()
    beforeEach(() => {
      __setPlannerLlmForTests(llm)
      llm.mockResolvedValue({
        text: 'Hi Jane,\n\nThursday works.\n\nBeth',
        model: 'claude-sonnet-4-6',
        inputTokens: 300,
        outputTokens: 40,
      })
    })

    async function generate(body: unknown) {
      const { POST } = await import('../../src/app/api/planner/drafts/[id]/generate/route')
      const res = await POST(
        json('http://localhost/api/planner/drafts/d-1/generate', 'POST', body),
        ctx
      )
      return { res, body: await res.json() }
    }

    it('replaces the body with the model text, clears pendingEmail, returns previousBody from the request when given', async () => {
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(
        draft({ body: 'stored body', pendingEmail: '{"gmailDraftId":"g1"}' })
      )
      const { res, body } = await generate({
        instructions: 'say yes to Thursday',
        mode: 'reply_email',
        currentBody: 'typed body',
      })
      expect(res.status).toBe(200)
      const call = llm.mock.calls[0][0]
      expect(call.maxTokens).toBe(2000)
      expect(call.orgId).toBe('org-1')
      expect(call.user).toContain('say yes to Thursday')
      expect(call.user).toContain('typed body')
      expect(call.user).toContain('Reply to Jane') // item context
      expect(call.system).toContain('Beth')
      expect(mockPrisma.plannerDraft.update.mock.calls[0][0]).toEqual({
        where: { id: 'd-1' },
        data: { body: 'Hi Jane,\n\nThursday works.\n\nBeth', pendingEmail: null },
      })
      expect(body).toEqual({
        draft: expect.objectContaining({ body: 'Hi Jane,\n\nThursday works.\n\nBeth' }),
        previousBody: 'typed body',
        model: 'claude-sonnet-4-6',
        inputTokens: 300,
        outputTokens: 40,
      })
    })

    it('falls back to the stored body as previousBody and works without an item', async () => {
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(
        draft({ itemId: null, body: 'stored body' })
      )
      const { body } = await generate({ instructions: 'make a one-pager', mode: 'document' })
      expect(body.previousBody).toBe('stored body')
      expect(mockPrisma.plannerItem.findFirst).not.toHaveBeenCalled()
      expect(llm.mock.calls[0][0].user).toContain('stored body')
    })

    it('validates instructions and mode', async () => {
      for (const b of [
        { mode: 'document' },
        { instructions: '', mode: 'document' },
        { instructions: 'x'.repeat(4001), mode: 'document' },
        { instructions: 'x', mode: 'poem' },
        { instructions: 'x', mode: 'document', currentBody: 'y'.repeat(50_001) },
      ]) {
        expect((await generate(b)).res.status, JSON.stringify(b).slice(0, 40)).toBe(400)
      }
      expect(llm).not.toHaveBeenCalled()
    })

    it('is limited to 10 per 10 minutes and maps 503/502', async () => {
      for (let i = 0; i < 10; i++)
        expect((await generate({ instructions: 'x', mode: 'freeform' })).res.status).toBe(200)
      expect((await generate({ instructions: 'x', mode: 'freeform' })).res.status).toBe(429)

      __resetRateLimitStore()
      llm.mockRejectedValue(new PlannerLlmUnconfiguredError('none'))
      const a = await generate({ instructions: 'x', mode: 'freeform' })
      expect(a.res.status).toBe(503)
      expect(a.body.error).toBe('No AI backend configured')
      llm.mockRejectedValue(new Error('boom'))
      expect((await generate({ instructions: 'x', mode: 'freeform' })).res.status).toBe(502)
    })

    it('404 for a foreign draft, 403 for API keys', async () => {
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(null)
      expect((await generate({ instructions: 'x', mode: 'freeform' })).res.status).toBe(404)
      mockRequireSession.mockResolvedValue(APIKEY)
      expect((await generate({ instructions: 'x', mode: 'freeform' })).res.status).toBe(403)
    })
  })
})
