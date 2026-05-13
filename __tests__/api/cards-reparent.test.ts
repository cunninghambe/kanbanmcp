/**
 * Tests for POST /api/cards/[cardId]/reparent
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

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

let txFindUniqueCalls: Array<{ id: string }> = []

const txMock = {
  card: {
    findUnique: vi.fn(({ where }: { where: { id: string } }): Promise<unknown> => {
      txFindUniqueCalls.push(where)
      return Promise.resolve(null)
    }),
    update: vi.fn().mockResolvedValue({}),
  },
  $queryRaw: vi.fn().mockResolvedValue([{ maxDepth: null }]),
  $executeRaw: vi.fn().mockResolvedValue(0),
}

const mockPrisma = {
  card: {
    findUnique: vi.fn(),
  },
  orgMember: {
    findUnique: vi.fn(),
  },
  apiKey: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
  $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
}

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

const membership = { userId: 'user-1', orgId: 'org-1', role: 'MEMBER' }

const baseCard = {
  id: 'card-A',
  parentCardId: null,
  path: '',
  depth: 0,
  boardId: 'board-1',
  aiReviewParams: null,
  board: { orgId: 'org-1', id: 'board-1' },
}

describe('POST /api/cards/[cardId]/reparent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    txFindUniqueCalls = []
    mockSession.userId = 'user-1'
    mockSession.orgId = 'org-1'
    Object.assign(mockSession, { isApiKeyAuth: undefined })
    txMock.card.findUnique.mockReset()
    txMock.$queryRaw.mockResolvedValue([{ maxDepth: null }])
    txMock.$executeRaw.mockResolvedValue(0)
    txMock.card.update.mockResolvedValue({})
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)
    )
  })

  it('returns 400 when parentCardId is self', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(baseCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-A',
    })
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Cannot reparent a card to itself')
  })

  it('returns 400 when new parent is on a different board (AC-9 board check)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(baseCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    txMock.card.findUnique.mockResolvedValueOnce({ boardId: 'other-board', depth: 0, path: '' })

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/same board/)
  })

  it('returns 400 when cycle detected (AC-9)', async () => {
    const cardA = { ...baseCard, id: 'card-A' }
    mockPrisma.card.findUnique.mockResolvedValue({
      ...cardA,
      board: { orgId: 'org-1', id: 'board-1' },
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    txMock.card.findUnique
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 1, path: '/card-A/' })
      .mockResolvedValueOnce({ parentCardId: 'card-A' })
      .mockResolvedValueOnce({ parentCardId: null })

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Cycle detected')
  })

  it('returns 400 when depth overflow would occur (AC-10)', async () => {
    const cardA = { ...baseCard, id: 'card-A', depth: 0 }
    mockPrisma.card.findUnique.mockResolvedValue({
      ...cardA,
      board: { orgId: 'org-1', id: 'board-1' },
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    txMock.card.findUnique
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 40, path: '/deep/' })
      .mockResolvedValueOnce(null)
    txMock.$queryRaw.mockResolvedValue([{ maxDepth: 10 }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Maximum nesting depth (50) reached')
  })

  it('reparent to null behaves like promote', async () => {
    const nestedCard = {
      ...baseCard,
      id: 'card-A',
      parentCardId: 'parent-1',
      path: '/parent-1/',
      depth: 1,
    }
    const updatedCard = { ...nestedCard, parentCardId: null, path: '', depth: 0 }
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ ...nestedCard, board: { orgId: 'org-1', id: 'board-1' } })
      .mockResolvedValueOnce(updatedCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    txMock.card.findUnique.mockResolvedValue(nestedCard)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', { parentCardId: null })
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(200)
    expect(txMock.card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { parentCardId: null } })
    )
  })

  it('happy path: valid reparent recomputes subtree inside transaction', async () => {
    const cardA = { ...baseCard, id: 'card-A', depth: 0, path: '' }
    const updatedCard = { ...cardA, parentCardId: 'card-B', path: '/card-B/', depth: 1 }
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ ...cardA, board: { orgId: 'org-1', id: 'board-1' } })
      .mockResolvedValueOnce(updatedCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    txMock.card.findUnique
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 0, path: '' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cardA)

    txMock.$queryRaw.mockResolvedValue([{ maxDepth: null }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(200)
    expect(mockPrisma.$transaction).toHaveBeenCalled()
  })

  it('returns 404 for non-existent card', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/nonexistent/reparent', {
      parentCardId: null,
    })
    const res = await POST(req, { params: { cardId: 'nonexistent' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 for cross-org card', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({
      ...baseCard,
      board: { orgId: 'other-org', id: 'board-1' },
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', { parentCardId: null })
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid body (missing parentCardId)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(baseCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {})
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(400)
  })

  it('accepts reparent when new parent is at depth 48 and card has no children (final depth 49)', async () => {
    const cardA = { ...baseCard, id: 'card-A', depth: 0, path: '' }
    const updatedCard = { ...cardA, parentCardId: 'card-B', path: '/card-B/', depth: 49 }
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ ...cardA, board: { orgId: 'org-1', id: 'board-1' } })
      .mockResolvedValueOnce(updatedCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    txMock.card.findUnique
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 48, path: '/deep/' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cardA)

    txMock.$queryRaw.mockResolvedValue([{ maxDepth: null }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(200)
  })

  it('rejects reparent when new parent is at depth 49 (would reach depth 50, AC-10)', async () => {
    const cardA = { ...baseCard, id: 'card-A', depth: 0 }
    mockPrisma.card.findUnique.mockResolvedValue({
      ...cardA,
      board: { orgId: 'org-1', id: 'board-1' },
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    txMock.card.findUnique
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 49, path: '/very/deep/' })
      .mockResolvedValueOnce(null)

    txMock.$queryRaw.mockResolvedValue([{ maxDepth: null }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: { cardId: 'card-A' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Maximum nesting depth (50) reached')
  })
})
