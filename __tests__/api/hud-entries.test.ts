/**
 * Tests for the HUD entries surface:
 *  - GET/POST  /api/hud/[id]/entries
 *  - PATCH/DELETE /api/hud/entries/[entryId]
 *  - POST /api/hud/entries/[entryId]/card (convert action → card)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'

const mockSession = {
  userId: 'user-1',
  orgId: 'org-1',
  save: vi.fn(),
}

vi.mock('iron-session', () => ({
  getIronSession: vi.fn().mockResolvedValue(mockSession),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockReturnValue({}),
}))

const mockPrisma = {
  hudSession: {
    findFirst: vi.fn(),
  },
  hudEntry: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    aggregate: vi.fn(),
  },
  orgMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  apiKey: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
  column: {
    findFirst: vi.fn(),
  },
  board: {
    findFirst: vi.fn(),
  },
  card: {
    aggregate: vi.fn(),
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string, method: string, body?: unknown, bearer?: string): NextRequest {
  return new NextRequest(url, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  })
}

function mockApiKeyAuth() {
  mockPrisma.apiKey.findUnique.mockResolvedValue({
    id: 'key-1',
    orgId: 'org-1',
    agentName: 'test-agent',
    permissions: '[]',
    keyHash: 'any',
  })
}

const membership = { userId: 'user-1', orgId: 'org-1', role: 'MEMBER' }

function createImpl() {
  return async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'entry-new',
    createdAt: new Date('2026-07-13T10:05:00'),
    updatedAt: new Date('2026-07-13T10:05:00'),
    checkedAt: null,
    cardId: null,
    ...data,
  })
}

// ─── GET /api/hud/[id]/entries ────────────────────────────────────────────────

describe('GET /api/hud/[id]/entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mockSession, { isApiKeyAuth: undefined, agentName: undefined })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
  })

  it('returns entries ordered (kind, position, createdAt)', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue({ id: 'hud-1' })
    mockPrisma.hudEntry.findMany.mockResolvedValue([{ id: 'entry-1', kind: 'agenda' }])

    const { GET } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'GET')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries).toHaveLength(1)
    expect(mockPrisma.hudEntry.findMany).toHaveBeenCalledWith({
      where: { hudSessionId: 'hud-1' },
      orderBy: [{ kind: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    })
  })

  it('returns 404 when the HUD session belongs to another org', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue(null)

    const { GET } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'GET')
    const res = await GET(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(404)
  })
})

// ─── POST /api/hud/[id]/entries ───────────────────────────────────────────────

describe('POST /api/hud/[id]/entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mockSession, { isApiKeyAuth: undefined, agentName: undefined })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    mockPrisma.hudSession.findFirst.mockResolvedValue({ id: 'hud-1', status: 'live' })
    mockPrisma.hudEntry.aggregate.mockResolvedValue({ _max: { position: null } })
    mockPrisma.hudEntry.create.mockImplementation(createImpl())
    mockPrisma.orgMember.findMany.mockResolvedValue([
      { userId: 'user-brad', orgId: 'org-1', role: 'MEMBER', user: { id: 'user-brad', name: 'Brad Pitt', email: 'brad@a1.dev' } },
    ])
  })

  it('POSITIVE: action entry resolves a single matching assignee and parses due:YYYY-MM-DD', async () => {
    const { POST } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'POST', {
      kind: 'action',
      text: '@Brad pay invoice due:2026-08-01',
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.entry.text).toBe('pay invoice')
    expect(body.entry.assigneeId).toBe('user-brad')
    expect(new Date(body.entry.dueDate).toISOString().slice(0, 10)).toBe('2026-08-01')
    expect(body.assigneeResolution).toBe('resolved')
  })

  it('returns 403 for API-key authenticated sessions', async () => {
    mockApiKeyAuth()
    const { POST } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'POST', { kind: 'note', text: 'hi' }, 'valid-key')
    const res = await POST(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Creating a HUD entry requires a human session')
  })

  it('returns 409 when the session is not live', async () => {
    mockPrisma.hudSession.findFirst.mockResolvedValue({ id: 'hud-1', status: 'ended' })
    const { POST } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'POST', { kind: 'note', text: 'hi' })
    const res = await POST(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(409)
  })

  it('NEGATIVE: note kind stores text verbatim — no token parsing, no assigneeResolution', async () => {
    const { POST } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'POST', {
      kind: 'note',
      text: '@brad due:fri',
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.entry.text).toBe('@brad due:fri')
    expect(body.assigneeResolution).toBeUndefined()
  })

  it('EDGE: ambiguous assignee saves the entry unassigned with candidates', async () => {
    mockPrisma.orgMember.findMany.mockResolvedValue([
      { userId: 'user-brad', orgId: 'org-1', role: 'MEMBER', user: { id: 'user-brad', name: 'Brad Pitt', email: 'brad@a1.dev' } },
      { userId: 'user-bradley', orgId: 'org-1', role: 'MEMBER', user: { id: 'user-bradley', name: 'Bradley Cooper', email: 'bradley@a1.dev' } },
    ])
    const { POST } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'POST', {
      kind: 'action',
      text: '@brad call them',
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.entry.assigneeId).toBeNull()
    expect(body.assigneeResolution).toBe('ambiguous')
    expect(body.candidates).toHaveLength(2)
    expect(body.candidates.length).toBeLessThanOrEqual(5)
  })

  it('NEGATIVE: an @mention that matches no org member resolves to none, unassigned, no candidates key', async () => {
    const { POST } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'POST', {
      kind: 'action',
      text: '@nobody call them',
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.entry.assigneeId).toBeNull()
    expect(body.assigneeResolution).toBe('none')
    expect(body.candidates).toBeUndefined()
  })

  it('NEGATIVE: an action entry with no @mention at all resolves to none, unassigned', async () => {
    const { POST } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'POST', {
      kind: 'action',
      text: 'ship the deck due:2026-08-01',
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.entry.assigneeId).toBeNull()
    expect(body.assigneeResolution).toBe('none')
    expect(body.candidates).toBeUndefined()
    expect(mockPrisma.orgMember.findMany).not.toHaveBeenCalled()
  })

  it('EDGE: default position is max+1 within (session, kind)', async () => {
    mockPrisma.hudEntry.aggregate.mockResolvedValue({ _max: { position: 3 } })
    const { POST } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'POST', {
      kind: 'agenda',
      text: 'discuss roadmap',
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'hud-1' }) })
    const body = await res.json()
    expect(body.entry.position).toBe(4)
    expect(mockPrisma.hudEntry.aggregate).toHaveBeenCalledWith({
      where: { hudSessionId: 'hud-1', kind: 'agenda' },
      _max: { position: true },
    })
  })

  it('DEGRADATION: an action entry that is only tokens (empty residual text) is rejected with 400', async () => {
    const { POST } = await import('../../src/app/api/hud/[id]/entries/route')
    const req = makeRequest('http://localhost/api/hud/hud-1/entries', 'POST', {
      kind: 'action',
      text: '@brad',
    })
    const res = await POST(req, { params: Promise.resolve({ id: 'hud-1' }) })
    expect(res.status).toBe(400)
    expect(mockPrisma.hudEntry.create).not.toHaveBeenCalled()
  })
})

// ─── PATCH /api/hud/entries/[entryId] ─────────────────────────────────────────

describe('PATCH /api/hud/entries/[entryId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mockSession, { isApiKeyAuth: undefined, agentName: undefined })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    mockPrisma.hudEntry.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'entry-1',
      orgId: 'org-1',
      kind: 'note',
      text: 'original',
      ...data,
    }))
  })

  it('returns 403 for API-key authenticated sessions', async () => {
    mockApiKeyAuth()
    const { PATCH } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'PATCH', { text: 'x' }, 'valid-key')
    const res = await PATCH(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the entry belongs to another org', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue(null)
    const { PATCH } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'PATCH', { text: 'x' })
    const res = await PATCH(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(404)
  })

  it('POSITIVE: patches text, position, and assigneeId on a live session', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      kind: 'action',
      hudSession: { status: 'live' },
    })
    const { PATCH } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'PATCH', {
      text: 'updated text',
      position: 2,
      assigneeId: 'user-x',
    })
    const res = await PATCH(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(200)
    expect(mockPrisma.hudEntry.update).toHaveBeenCalledWith({
      where: { id: 'entry-1' },
      data: { text: 'updated text', position: 2, assigneeId: 'user-x' },
    })
  })

  it('POSITIVE: { checked: true } on an agenda entry is allowed on an ENDED session and sets checkedAt', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      kind: 'agenda',
      hudSession: { status: 'ended' },
    })
    const { PATCH } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'PATCH', { checked: true })
    const res = await PATCH(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(200)
    const call = mockPrisma.hudEntry.update.mock.calls[0][0]
    expect(call.data.checkedAt).toBeInstanceOf(Date)
  })

  it('{ checked: false } clears checkedAt', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      kind: 'agenda',
      hudSession: { status: 'live' },
    })
    const { PATCH } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'PATCH', { checked: false })
    const res = await PATCH(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(200)
    expect(mockPrisma.hudEntry.update).toHaveBeenCalledWith({
      where: { id: 'entry-1' },
      data: { checkedAt: null },
    })
  })

  it('EDGE: 409 when the session has ended and the patch is not a checked-only agenda patch', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      kind: 'agenda',
      hudSession: { status: 'ended' },
    })
    const { PATCH } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'PATCH', { text: 'x', checked: true })
    const res = await PATCH(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(409)
  })

  it('MINOR FIX: returns 400 when checked is patched on a non-agenda entry on a LIVE session', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      kind: 'note',
      hudSession: { status: 'live' },
    })
    const { PATCH } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'PATCH', { checked: true })
    const res = await PATCH(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('checked applies only to agenda entries')
    expect(mockPrisma.hudEntry.update).not.toHaveBeenCalled()
  })

  it('MINOR FIX: returns 400 (not 409) when checked is patched on a non-agenda entry on an ENDED session — checked is agenda-only regardless of session status', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      kind: 'note',
      hudSession: { status: 'ended' },
    })
    const { PATCH } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'PATCH', { checked: true })
    const res = await PATCH(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('checked applies only to agenda entries')
  })

  it('returns 400 for an empty patch body', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      kind: 'note',
      hudSession: { status: 'live' },
    })
    const { PATCH } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'PATCH', {})
    const res = await PATCH(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(400)
  })
})

// ─── DELETE /api/hud/entries/[entryId] ────────────────────────────────────────

describe('DELETE /api/hud/entries/[entryId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mockSession, { isApiKeyAuth: undefined, agentName: undefined })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    mockPrisma.hudEntry.delete.mockResolvedValue({})
  })

  it('returns 403 for API-key authenticated sessions', async () => {
    mockApiKeyAuth()
    const { DELETE } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'DELETE', undefined, 'valid-key')
    const res = await DELETE(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the entry belongs to another org', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue(null)
    const { DELETE } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'DELETE')
    const res = await DELETE(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 409 when the session is not live (no exception for DELETE)', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      kind: 'agenda',
      hudSession: { status: 'ended' },
    })
    const { DELETE } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'DELETE')
    const res = await DELETE(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(409)
  })

  it('POSITIVE: deletes the entry on a live session', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      kind: 'note',
      hudSession: { status: 'live' },
    })
    const { DELETE } = await import('../../src/app/api/hud/entries/[entryId]/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1', 'DELETE')
    const res = await DELETE(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    expect(mockPrisma.hudEntry.delete).toHaveBeenCalledWith({ where: { id: 'entry-1' } })
  })
})

// ─── POST /api/hud/entries/[entryId]/card (convert) ──────────────────────────

describe('POST /api/hud/entries/[entryId]/card', () => {
  const baseEntry = {
    id: 'entry-1',
    orgId: 'org-1',
    hudSessionId: 'hud-1',
    kind: 'action',
    text: 'send contract',
    assigneeId: 'user-brad',
    dueDate: new Date('2026-07-17T00:00:00'),
    cardId: null,
    hudSession: { boardId: 'board-1' },
  }

  function setupTransactionMock() {
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) =>
        fn({
          hudEntry: {
            updateMany: mockPrisma.hudEntry.updateMany,
            findUniqueOrThrow: mockPrisma.hudEntry.findUniqueOrThrow,
          },
          card: {
            aggregate: mockPrisma.card.aggregate,
            create: mockPrisma.card.create,
          },
        } as unknown as typeof mockPrisma)
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mockSession, { isApiKeyAuth: undefined, agentName: undefined })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    mockPrisma.hudEntry.findFirst.mockResolvedValue({ ...baseEntry })
    mockPrisma.board.findFirst.mockResolvedValue({ id: 'board-1' })
    mockPrisma.column.findFirst.mockResolvedValue({ id: 'col-left', boardId: 'board-1', position: 0 })
    mockPrisma.card.aggregate.mockResolvedValue({ _max: { position: null } })
    mockPrisma.card.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'card-new',
      ...data,
    }))
    // The conditional claim: count 1 = won the race (default happy path).
    mockPrisma.hudEntry.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.hudEntry.findUniqueOrThrow.mockImplementation(async () => ({
      ...baseEntry,
      cardId: 'card-new',
    }))
    setupTransactionMock()
  })

  it('returns 403 for API-key authenticated sessions', async () => {
    mockApiKeyAuth()
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST', {}, 'valid-key')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the entry belongs to another org', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue(null)
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 400 when the entry kind is not action', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({ ...baseEntry, kind: 'note' })
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(400)
  })

  it('returns 409 when the session has no board attached', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({ ...baseEntry, hudSession: { boardId: null } })
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('Attach a board to create cards')
  })

  it('MINOR FIX: returns 404 when the session boardId does not resolve to a board in this org (defense in depth)', async () => {
    mockPrisma.board.findFirst.mockResolvedValue(null)
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Board not found')
    expect(mockPrisma.board.findFirst).toHaveBeenCalledWith({
      where: { id: 'board-1', orgId: 'org-1' },
      select: { id: true },
    })
    expect(mockPrisma.card.create).not.toHaveBeenCalled()
  })

  it('returns 409 when entry.cardId is already set (pre-check)', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({ ...baseEntry, cardId: 'card-existing' })
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(409)
    expect(mockPrisma.card.create).not.toHaveBeenCalled()
  })

  it('returns 400 when the provided columnId does not belong to the session board', async () => {
    mockPrisma.column.findFirst.mockResolvedValue(null)
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST', { columnId: 'col-other-board' })
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(400)
  })

  it('POSITIVE: creates the card in the leftmost column with assignee/due date carried over, in one transaction', async () => {
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.card.columnId).toBe('col-left')
    expect(body.card.title).toBe('send contract')
    expect(body.card.assigneeId).toBe('user-brad')
    expect(body.card.dueDate).toBe(baseEntry.dueDate.toISOString())
    expect(body.card.position).toBe(1)
    expect(body.entry.cardId).toBe('card-new')
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('IMPORTANT FIX: idempotence — losing the conditional cardId claim rolls back the transaction and returns 409 with nothing visible to the client', async () => {
    // The claim (updateMany scoped to cardId: null) matches zero rows: a
    // concurrent convert already won and committed first.
    mockPrisma.hudEntry.updateMany.mockResolvedValue({ count: 0 })
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual({ error: 'Card already created for this entry' })
    expect(body.card).toBeUndefined()
    expect(body.entry).toBeUndefined()
    // findUniqueOrThrow only runs after a won claim — never reached here.
    expect(mockPrisma.hudEntry.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it('IMPORTANT FIX: a unique-constraint violation (P2002) on the claim is caught as a belt-and-suspenders case, mapped to the same 409', async () => {
    mockPrisma.hudEntry.updateMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`cardId`)', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['cardId'] },
      })
    )
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual({ error: 'Card already created for this entry' })
    expect(body.card).toBeUndefined()
    expect(body.entry).toBeUndefined()
  })

  it('EDGE: text over 200 chars is truncated for the title, full text goes into the description', async () => {
    const longText = 'x'.repeat(250)
    mockPrisma.hudEntry.findFirst.mockResolvedValue({ ...baseEntry, text: longText })
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.card.title).toHaveLength(200)
    expect(body.card.description).toBe(longText)
  })

  it('convert is allowed even when the session has ended (no status gate on this route)', async () => {
    mockPrisma.hudEntry.findFirst.mockResolvedValue({
      ...baseEntry,
      hudSession: { boardId: 'board-1', status: 'ended' },
    })
    const { POST } = await import('../../src/app/api/hud/entries/[entryId]/card/route')
    const req = makeRequest('http://localhost/api/hud/entries/entry-1/card', 'POST')
    const res = await POST(req, { params: Promise.resolve({ entryId: 'entry-1' }) })
    expect(res.status).toBe(201)
  })
})
