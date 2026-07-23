/**
 * Inbox-agent backend: the /api/inbox-agent proxy, the /api/nudges/[id]/ack
 * route, and the /api/cron/inbox-expire cron. Covers A6 (everything except the
 * create_nudge MCP tool, which lives in __tests__/mcp/nudges.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = vi.hoisted(() => ({
  nudge: { findFirst: vi.fn(), update: vi.fn() },
  board: { findUnique: vi.fn() },
  card: { update: vi.fn() },
  comment: { create: vi.fn() },
}))
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

// ─── Mock api-helpers ─────────────────────────────────────────────────────────
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

vi.mock('../../src/lib/agent-activity', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }))

const HUMAN = { userId: 'user-1', orgId: 'org-1' }
const APIKEY = { userId: '', orgId: 'org-1', isApiKeyAuth: true, agentName: 'inbox-agent' }

function okFetch(json: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({ json: () => Promise.resolve(json) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireSession.mockResolvedValue(HUMAN)
  mockRequireOrgRole.mockResolvedValue({ role: 'MEMBER' })
})

// ─── /api/inbox-agent proxy ─────────────────────────────────────────────────
describe('POST /api/inbox-agent', () => {
  function makeRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/inbox-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rejects API-key sessions with 403 (send path is human-only)', async () => {
    mockRequireSession.mockResolvedValue(APIKEY)
    vi.stubEnv('INBOX_AGENT_URL', 'https://script/exec')
    vi.stubEnv('INBOX_AGENT_TOKEN', 'server-token')
    const fetchMock = okFetch({ draftId: 'd1' })
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('../../src/app/api/inbox-agent/route')
    const res = await POST(makeRequest({ action: 'draft', threadId: 't1', instructions: 'hi' }))
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 503 when env is not configured', async () => {
    vi.stubEnv('INBOX_AGENT_URL', '')
    vi.stubEnv('INBOX_AGENT_TOKEN', '')
    const { POST } = await import('../../src/app/api/inbox-agent/route')
    const res = await POST(makeRequest({ action: 'ack', threadId: 't1' }))
    expect(res.status).toBe(503)
  })

  it('forwards draft to the upstream with the ENV token injected server-side', async () => {
    vi.stubEnv('INBOX_AGENT_URL', 'https://script/exec')
    vi.stubEnv('INBOX_AGENT_TOKEN', 'server-token')
    const fetchMock = okFetch({ draftId: 'd1', preview: 'body', to: 'x@y.com' })
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('../../src/app/api/inbox-agent/route')
    // Client sends NO token — the proxy must inject it.
    const res = await POST(
      makeRequest({ action: 'draft', threadId: 't1', instructions: 'say yes', token: 'CLIENT-TRIED' })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.draftId).toBe('d1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe('https://script/exec')
    const sentBody = JSON.parse(calledInit.body)
    expect(sentBody.token).toBe('server-token') // from env, not the client
    expect(sentBody.token).not.toBe('CLIENT-TRIED')
    expect(sentBody.action).toBe('draft')
    expect(sentBody.threadId).toBe('t1')
    expect(sentBody.instructions).toBe('say yes')
  })

  it('maps an upstream { error } to HTTP 502', async () => {
    vi.stubEnv('INBOX_AGENT_URL', 'https://script/exec')
    vi.stubEnv('INBOX_AGENT_TOKEN', 'server-token')
    vi.stubGlobal('fetch', okFetch({ error: 'gmail rate limited' }))

    const { POST } = await import('../../src/app/api/inbox-agent/route')
    const res = await POST(makeRequest({ action: 'send', draftId: 'd1' }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('gmail rate limited')
  })

  it('rejects a draft missing instructions with 400', async () => {
    vi.stubEnv('INBOX_AGENT_URL', 'https://script/exec')
    vi.stubEnv('INBOX_AGENT_TOKEN', 'server-token')
    const fetchMock = okFetch({})
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('../../src/app/api/inbox-agent/route')
    const res = await POST(makeRequest({ action: 'draft', threadId: 't1' }))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── /api/nudges/[id]/ack ─────────────────────────────────────────────────────
describe('POST /api/nudges/[id]/ack', () => {
  const ctx = { params: Promise.resolve({ id: 'nudge-1' }) }
  function makeRequest(): NextRequest {
    return new NextRequest('http://localhost/api/nudges/nudge-1/ack', { method: 'POST' })
  }

  it('rejects API-key sessions with 403', async () => {
    mockRequireSession.mockResolvedValue(APIKEY)
    const { POST } = await import('../../src/app/api/nudges/[id]/ack/route')
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(403)
    expect(mockPrisma.nudge.update).not.toHaveBeenCalled()
  })

  it('flips a pending nudge to acked for a human session (200)', async () => {
    mockPrisma.nudge.findFirst.mockResolvedValue({ id: 'nudge-1', status: 'pending', gmailThreadId: null })
    mockPrisma.nudge.update.mockResolvedValue({ id: 'nudge-1', status: 'acked' })
    vi.stubEnv('INBOX_AGENT_URL', '')
    vi.stubEnv('INBOX_AGENT_TOKEN', '')

    const { POST } = await import('../../src/app/api/nudges/[id]/ack/route')
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(200)
    expect(mockPrisma.nudge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'nudge-1' },
        data: expect.objectContaining({ status: 'acked', ackedById: 'user-1' }),
      })
    )
  })

  it('fires the Gmail label-clear callback when env is set', async () => {
    mockPrisma.nudge.findFirst.mockResolvedValue({
      id: 'nudge-1',
      status: 'pending',
      gmailThreadId: 'thread-xyz',
    })
    mockPrisma.nudge.update.mockResolvedValue({ id: 'nudge-1', status: 'acked' })
    vi.stubEnv('INBOX_AGENT_URL', 'https://script/exec')
    vi.stubEnv('INBOX_AGENT_TOKEN', 'server-token')
    const fetchMock = okFetch({ acked: true })
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('../../src/app/api/nudges/[id]/ack/route')
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(200)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://script/exec')
    const sent = JSON.parse(init.body)
    expect(sent).toMatchObject({ token: 'server-token', action: 'ack', threadId: 'thread-xyz' })
  })

  it('is idempotent — acking an already-acked nudge returns 200 without re-firing', async () => {
    mockPrisma.nudge.findFirst.mockResolvedValue({
      id: 'nudge-1',
      status: 'acked',
      gmailThreadId: 'thread-xyz',
    })
    vi.stubEnv('INBOX_AGENT_URL', 'https://script/exec')
    vi.stubEnv('INBOX_AGENT_TOKEN', 'server-token')
    const fetchMock = okFetch({ acked: true })
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('../../src/app/api/nudges/[id]/ack/route')
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(200)
    expect(mockPrisma.nudge.update).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── /api/cron/inbox-expire ──────────────────────────────────────────────────
describe('POST /api/cron/inbox-expire', () => {
  const CRON_SECRET = 'test-cron-secret'
  function makeRequest(authHeader?: string): NextRequest {
    return new NextRequest('http://localhost/api/cron/inbox-expire', {
      method: 'POST',
      headers: authHeader ? { authorization: authHeader } : {},
    })
  }

  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', CRON_SECRET)
    vi.stubEnv('INBOX_BOARD_ID', 'board-1')
    vi.stubEnv('INBOX_EXPIRE_DAYS', '5')
  })

  it('returns 401 for a bad bearer token', async () => {
    const { POST } = await import('../../src/app/api/cron/inbox-expire/route')
    const res = await POST(makeRequest('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(mockPrisma.card.update).not.toHaveBeenCalled()
  })

  it('no-ops with reason "unconfigured" when INBOX_BOARD_ID is unset', async () => {
    vi.stubEnv('INBOX_BOARD_ID', '')
    const { POST } = await import('../../src/app/api/cron/inbox-expire/route')
    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ expired: 0, reason: 'unconfigured' })
  })

  it('no-ops with reason "no_digest_column" when the board has no Digest column', async () => {
    mockPrisma.board.findUnique.mockResolvedValue({
      id: 'board-1',
      columns: [{ id: 'c-triage', name: 'Triage', cards: [] }],
    })
    const { POST } = await import('../../src/app/api/cron/inbox-expire/route')
    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`))
    expect(await res.json()).toEqual({ expired: 0, reason: 'no_digest_column' })
  })

  it('moves only stale non-exempt cards into Digest; exempts Urgent/Digest/Done', async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days old → stale
    const fresh = new Date() // touched now → not stale
    mockPrisma.board.findUnique.mockResolvedValue({
      id: 'board-1',
      columns: [
        {
          id: 'c-urgent',
          name: 'Urgent',
          cards: [{ id: 'u1', position: 1, updatedAt: old }],
        },
        {
          id: 'c-triage',
          name: 'Triage',
          cards: [
            { id: 't-stale', position: 1, updatedAt: old },
            { id: 't-fresh', position: 2, updatedAt: fresh },
          ],
        },
        {
          id: 'c-done',
          name: 'Done',
          cards: [{ id: 'd1', position: 1, updatedAt: old }],
        },
        { id: 'c-digest', name: 'Digest', cards: [{ id: 'g1', position: 1, updatedAt: old }] },
      ],
    })
    mockPrisma.card.update.mockResolvedValue({})
    mockPrisma.comment.create.mockResolvedValue({})

    const { POST } = await import('../../src/app/api/cron/inbox-expire/route')
    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`))
    expect(await res.json()).toEqual({ expired: 1 })

    // Only the stale Triage card moves; Urgent/Done/Digest and the fresh card stay put.
    expect(mockPrisma.card.update).toHaveBeenCalledTimes(1)
    const arg = mockPrisma.card.update.mock.calls[0][0]
    expect(arg.where).toEqual({ id: 't-stale' })
    expect(arg.data.columnId).toBe('c-digest')
    expect(arg.data.position).toBe(2) // end of Digest (existing max 1 → +1)

    expect(mockPrisma.comment.create).toHaveBeenCalledTimes(1)
    const commentArg = mockPrisma.comment.create.mock.calls[0][0]
    expect(commentArg.data.agentId).toBe('inbox-agent')
    expect(commentArg.data.userId).toBeNull()
    expect(commentArg.data.content).toContain('Triage')
    expect(commentArg.data.content).toContain('5 days')
  })
})
