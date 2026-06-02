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
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Cannot reparent a card to itself')
  })

  it('returns 400 when new parent is on a different board (AC-9 board check)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(baseCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    txMock.card.findUnique
      // 1) fresh in-tx read of the moved card (path/depth)
      .mockResolvedValueOnce({ path: '', depth: 0 })
      // 2) new parent lookup — different board
      .mockResolvedValueOnce({ boardId: 'other-board', depth: 0, path: '' })

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
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
      // 1) fresh in-tx read of moved card-A
      .mockResolvedValueOnce({ path: '', depth: 0 })
      // 2) new parent (card-B) lookup — same board, NOT inside card-A subtree
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 1, path: '/other/' })
      // 3+) wouldFormCycle ancestor walk from card-B reaches card-A
      .mockResolvedValueOnce({ parentCardId: 'card-A' })
      .mockResolvedValueOnce({ parentCardId: null })

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
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
      // 1) fresh in-tx read of moved card-A
      .mockResolvedValueOnce({ path: '', depth: 0 })
      // 2) new parent lookup — same board, deep
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 40, path: '/deep/' })
      // 3) wouldFormCycle ancestor walk terminates immediately
      .mockResolvedValueOnce(null)
    txMock.$queryRaw.mockResolvedValue([{ maxDepth: 10 }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
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
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
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
      // 1) fresh in-tx read of moved card-A
      .mockResolvedValueOnce({ path: '', depth: 0 })
      // 2) new parent (card-B) lookup — same board, root
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 0, path: '' })
      // 3) wouldFormCycle ancestor walk terminates
      .mockResolvedValueOnce(null)
      // 4) recomputeSubtreePathAndDepth re-reads card-A
      .mockResolvedValueOnce(cardA)

    txMock.$queryRaw.mockResolvedValue([{ maxDepth: null }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
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
    const res = await POST(req, { params: Promise.resolve({ cardId: 'nonexistent' }) })
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
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid body (missing parentCardId)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(baseCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {})
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
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
      // 1) fresh in-tx read of moved card-A
      .mockResolvedValueOnce({ path: '', depth: 0 })
      // 2) new parent (card-B) lookup — same board, depth 48
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 48, path: '/deep/' })
      // 3) wouldFormCycle ancestor walk terminates
      .mockResolvedValueOnce(null)
      // 4) recomputeSubtreePathAndDepth re-reads card-A
      .mockResolvedValueOnce(cardA)

    txMock.$queryRaw.mockResolvedValue([{ maxDepth: null }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
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
      // 1) fresh in-tx read of moved card-A
      .mockResolvedValueOnce({ path: '', depth: 0 })
      // 2) new parent (card-B) lookup — same board, depth 49
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 49, path: '/very/deep/' })
      // 3) wouldFormCycle ancestor walk terminates
      .mockResolvedValueOnce(null)

    txMock.$queryRaw.mockResolvedValue([{ maxDepth: null }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Maximum nesting depth (50) reached')
  })

  // ─── Fix G4.3: fresh in-tx depth + cycle-via-path guard ──────────────────────

  it('uses the FRESH in-tx card path/depth (not the pre-tx snapshot) for the depth budget', async () => {
    // The pre-transaction snapshot says card-A is a shallow root (depth 0),
    // but a concurrent edit moved it deep before our tx ran. The in-tx read
    // reflects the fresh state and must drive the depth-budget rejection.
    const staleCardA = { ...baseCard, id: 'card-A', depth: 0, path: '' }
    mockPrisma.card.findUnique.mockResolvedValue({
      ...staleCardA,
      board: { orgId: 'org-1', id: 'board-1' },
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    txMock.card.findUnique
      // 1) FRESH in-tx read: card-A is actually deep now (depth 30, path '/x/')
      .mockResolvedValueOnce({ path: '/x/', depth: 30 })
      // 2) new parent lookup — same board, depth 45
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 45, path: '/p/' })
      // 3) wouldFormCycle ancestor walk terminates
      .mockResolvedValueOnce(null)

    // Subtree's deepest descendant is at absolute depth 35 -> subtreeMaxDepth = 35-30 = 5.
    // newParent.depth + 1 + 5 = 45 + 1 + 5 = 51 >= 50 -> reject.
    // (If the stale depth 0 had been used, subtreeMaxDepth = 35 and it would have
    //  been even larger, but the point is the prefix LIKE uses the FRESH path '/x/card-A/'.)
    txMock.$queryRaw.mockResolvedValue([{ maxDepth: 35 }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-B',
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Maximum nesting depth (50) reached')
    // Confirm the depth query used the FRESH subtree prefix derived from path '/x/'.
    const queryArgs = txMock.$queryRaw.mock.calls[0]
    expect(JSON.stringify(queryArgs)).toContain('/x/card-A/')
  })

  it('rejects reparenting a card UNDER its own descendant via the path-prefix cycle guard', async () => {
    // wouldFormCycle relies on parentCardId pointers; if those were edited
    // concurrently it could miss the cycle. The path-prefix check catches it:
    // the new parent lives inside card-A's own subtree.
    const cardA = { ...baseCard, id: 'card-A', depth: 1, path: '/root/' }
    mockPrisma.card.findUnique.mockResolvedValue({
      ...cardA,
      board: { orgId: 'org-1', id: 'board-1' },
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    txMock.card.findUnique
      // 1) fresh in-tx read of moved card-A (subtree prefix = '/root/card-A/')
      .mockResolvedValueOnce({ path: '/root/', depth: 1 })
      // 2) new parent is a descendant of card-A (path starts with '/root/card-A/')
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 2, path: '/root/card-A/' })
      // 3) wouldFormCycle ancestor walk is (deliberately) sabotaged: pointer says
      //    the descendant has no parent, so ancestor-walk alone would MISS the cycle.
      .mockResolvedValue({ parentCardId: null })

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-descendant',
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Cycle detected')
  })

  it('allows reparenting under a sibling subtree that merely SHARES a path prefix string', async () => {
    // NEGATIVE / false-positive boundary: new parent path '/root/card-AB/' must
    // NOT be treated as inside card-A's subtree prefix '/root/card-A/'.
    const cardA = { ...baseCard, id: 'card-A', depth: 1, path: '/root/' }
    const updatedCard = { ...cardA, parentCardId: 'card-AB', path: '/root/card-AB/', depth: 2 }
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ ...cardA, board: { orgId: 'org-1', id: 'board-1' } })
      .mockResolvedValueOnce(updatedCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    txMock.card.findUnique
      // 1) fresh in-tx read of moved card-A (subtree prefix = '/root/card-A/')
      .mockResolvedValueOnce({ path: '/root/', depth: 1 })
      // 2) new parent '/root/card-AB/' shares the '/root/card-A' string but is a
      //    DIFFERENT subtree — startsWith('/root/card-A/') is false.
      .mockResolvedValueOnce({ boardId: 'board-1', depth: 2, path: '/root/' })
      // 3) wouldFormCycle ancestor walk terminates (no real cycle)
      .mockResolvedValueOnce(null)
      // 4) recompute re-reads card-A
      .mockResolvedValueOnce(cardA)

    txMock.$queryRaw.mockResolvedValue([{ maxDepth: null }])

    const { POST } = await import('../../src/app/api/cards/[cardId]/reparent/route')
    const req = makeRequest('http://localhost/api/cards/card-A/reparent', {
      parentCardId: 'card-AB',
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-A' }) })
    expect(res.status).toBe(200)
  })
})
