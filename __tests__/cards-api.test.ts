/**
 * Tests for card API routes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session ────────────────────────────────────────────────────────
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

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  card: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
  },
  cardLabel: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  orgMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
}

vi.mock('../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

vi.mock('../src/lib/card-movement', () => ({
  recordCardMovement: vi.fn().mockResolvedValue({ id: 'mv-stub' }),
}))

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

const baseCard = {
  id: 'card-1',
  title: 'Test Card',
  description: 'A card',
  columnId: 'col-1',
  boardId: 'board-1',
  sprintId: null,
  assigneeId: null,
  agentId: null,
  position: 0,
  dueDate: null,
  priority: 'none',
  createdById: 'user-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  board: { orgId: 'org-1' },
  labels: [],
  comments: [],
  assignee: null,
  createdBy: { id: 'user-1', email: 'user@example.com', name: 'User' },
  column: { id: 'col-1', name: 'Backlog' },
  sprint: null,
}

// ─── GET /api/cards/[cardId] ──────────────────────────────────────────────────
describe('GET /api/cards/[cardId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
  })

  it('returns 404 when card not found', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    const { GET } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/nonexistent', 'GET')
    const res = await GET(req, { params: Promise.resolve({ cardId: 'nonexistent' }) })
    expect(res.status).toBe(404)
  })

  it('returns 404 when card belongs to different org', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({
      ...baseCard,
      board: { orgId: 'other-org' },
    })
    const { GET } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'GET')
    const res = await GET(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns card details on success', async () => {
    // First call: resolveCard
    mockPrisma.card.findUnique.mockResolvedValueOnce({ id: 'card-1', board: { orgId: 'org-1' } })
    // Second call: full card fetch
    mockPrisma.card.findUnique.mockResolvedValueOnce(baseCard)
    const { GET } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'GET')
    const res = await GET(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.card.id).toBe('card-1')
    expect(body.card.title).toBe('Test Card')
  })
})

// ─── PATCH /api/cards/[cardId] ────────────────────────────────────────────────
describe('PATCH /api/cards/[cardId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
  })

  it('returns 400 for empty title', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ ...baseCard })
    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { title: '' })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(400)
  })

  it('updates card title successfully', async () => {
    // resolveCard call
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    // final fetch after update
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, title: 'Updated Title' })
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          card: { update: vi.fn().mockResolvedValue({}) },
          cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
        } as unknown as typeof mockPrisma)
      }
    )
    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', {
      title: 'Updated Title',
    })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.card.title).toBe('Updated Title')
  })

  it('handles column move with auto-position', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findMany.mockResolvedValue([])
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          card: {
            update: vi.fn().mockResolvedValue({}),
            // max-position read now happens inside the transaction
            findFirst: vi.fn().mockResolvedValue({ position: 2 }),
          },
          cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
        } as unknown as typeof mockPrisma)
      }
    )
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, columnId: 'col-2' })

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { columnId: 'col-2' })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
  })

  it('returns 400 when sibling card IDs are invalid', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findFirst.mockResolvedValue(null)
    // Return fewer valid siblings than requested
    mockPrisma.card.findMany.mockResolvedValue([{ id: 'card-sibling-1' }])

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', {
      columnId: 'col-2',
      siblingPositions: [
        { id: 'card-sibling-1', position: 0 },
        { id: 'nonexistent-card', position: 1 },
      ],
    })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('sibling card IDs')
  })
})

// ─── DELETE /api/cards/[cardId] ───────────────────────────────────────────────
describe('DELETE /api/cards/[cardId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
  })

  it('deletes card and returns success', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ id: 'card-1', board: { orgId: 'org-1' } })
    mockPrisma.card.delete.mockResolvedValue({})
    const { DELETE } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'DELETE')
    const res = await DELETE(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('returns 404 when card not found', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    const { DELETE } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'DELETE')
    const res = await DELETE(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(404)
  })
})

// ─── Priority field tests ─────────────────────────────────────────────────────
describe('PATCH /api/cards/[cardId] - priority field', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
  })

  it('accepts valid priority values', async () => {
    const validPriorities = ['none', 'low', 'medium', 'high', 'critical']
    for (const priority of validPriorities) {
      vi.clearAllMocks()
      mockPrisma.orgMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        orgId: 'org-1',
        role: 'MEMBER',
      })
      mockPrisma.card.findUnique.mockResolvedValueOnce({
        id: 'card-1',
        columnId: 'col-1',
        boardId: 'board-1',
        board: { orgId: 'org-1' },
      })
      mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, priority })
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          return fn({
            card: { update: vi.fn().mockResolvedValue({}) },
            cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
          } as unknown as typeof mockPrisma)
        }
      )
      const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
      const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { priority })
      const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.card.priority).toBe(priority)
    }
  })

  it('rejects invalid priority value', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { priority: 'urgent' })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(400)
  })

  it('does not clobber existing priority when priority absent from body', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      ...baseCard,
      priority: 'high',
      title: 'New Title',
    })
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          card: { update: vi.fn().mockResolvedValue({}) },
          cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
          orgMember: {
            findUnique: vi.fn().mockResolvedValue({ userId: 'user-1', orgId: 'org-1' }),
          },
        } as unknown as typeof mockPrisma)
      }
    )
    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    // Send only title, no priority field
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { title: 'New Title' })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Priority should remain "high" (not overwritten)
    expect(body.card.priority).toBe('high')
  })
})

// ─── Assignee IDOR protection ─────────────────────────────────────────────────
describe('PATCH /api/cards/[cardId] - assignee IDOR protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
  })

  it('rejects assigneeId from a different org', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    // requireOrgRole uses findUnique; roleMembershipCheck uses findMany
    mockPrisma.orgMember.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
    // findMany returns empty — user-from-other-org is not in org
    mockPrisma.orgMember.findMany.mockResolvedValueOnce([])

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', {
      assigneeId: 'user-from-other-org',
    })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('member of this organization')
  })
})

// ─── Move-position collision: max read inside the transaction (Fix G4.2) ──────
describe('PATCH /api/cards/[cardId] - append position computed inside the tx', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
  })

  it('POSITIVE: when changing column without a position, max+1 is read via the tx client', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, columnId: 'col-2', position: 6 })

    // The pre-tx findFirst MUST NOT be consulted for the move position anymore.
    mockPrisma.card.findFirst.mockResolvedValue({ position: 999 })

    const txUpdate = vi.fn().mockResolvedValue({})
    const txFindFirst = vi.fn().mockResolvedValue({ position: 5 })
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          card: { update: txUpdate, findFirst: txFindFirst },
          cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
        } as unknown as typeof mockPrisma)
      }
    )

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { columnId: 'col-2' })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)

    // Max-position read happened on the tx client, not on the outer prisma client.
    expect(txFindFirst).toHaveBeenCalledTimes(1)
    expect(mockPrisma.card.findFirst).not.toHaveBeenCalled()
    // Position written = tx max (5) + 1 = 6.
    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 6 }) })
    )
  })

  it('NEGATIVE: an explicit position is respected and no max read happens', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, columnId: 'col-2', position: 3 })

    const txUpdate = vi.fn().mockResolvedValue({})
    const txFindFirst = vi.fn().mockResolvedValue({ position: 99 })
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          card: { update: txUpdate, findFirst: txFindFirst },
          cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
        } as unknown as typeof mockPrisma)
      }
    )

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', {
      columnId: 'col-2',
      position: 3,
    })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    // No append read when caller supplied an explicit position.
    expect(txFindFirst).not.toHaveBeenCalled()
    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 3 }) })
    )
  })

  it('EDGE: empty target column appends at position 0 (tx max read returns null)', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, columnId: 'col-2', position: 0 })

    const txUpdate = vi.fn().mockResolvedValue({})
    const txFindFirst = vi.fn().mockResolvedValue(null)
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          card: { update: txUpdate, findFirst: txFindFirst },
          cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
        } as unknown as typeof mockPrisma)
      }
    )

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { columnId: 'col-2' })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    expect(txFindFirst).toHaveBeenCalledTimes(1)
    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 0 }) })
    )
  })

  it('EDGE: same-column position-only update does not trigger any max read', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, position: 2 })

    const txUpdate = vi.fn().mockResolvedValue({})
    const txFindFirst = vi.fn().mockResolvedValue({ position: 50 })
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          card: { update: txUpdate, findFirst: txFindFirst },
          cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
        } as unknown as typeof mockPrisma)
      }
    )

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    // Same column (col-1), explicit new position.
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', {
      columnId: 'col-1',
      position: 2,
    })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    expect(txFindFirst).not.toHaveBeenCalled()
    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 2 }) })
    )
  })
})
