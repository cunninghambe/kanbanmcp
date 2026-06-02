/**
 * Tests for board-scoped label attachment (Fix G4.1):
 *  - POST /api/boards/[boardId]/cards
 *  - PATCH /api/cards/[cardId]
 *
 * Label IDs supplied on create/update must belong to the same board as the
 * card. A label from another board (even within the same org) must be rejected
 * with 400 before any CardLabel rows are written.
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

const mockPrisma = {
  board: {
    findUnique: vi.fn(),
  },
  card: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
  column: {
    findUnique: vi.fn(),
  },
  label: {
    findMany: vi.fn(),
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

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── POST /api/boards/[boardId]/cards ─────────────────────────────────────────

const createdCard = {
  id: 'card-new',
  title: 'New Card',
  description: null,
  columnId: 'col-1',
  boardId: 'board-1',
  sprintId: null,
  assigneeId: 'user-1',
  reviewerId: null,
  approverId: null,
  parentCardId: null,
  path: '',
  depth: 0,
  aiAutoReview: false,
  aiReviewParams: null,
  agentId: null,
  position: 0,
  dueDate: null,
  priority: 'none',
  createdById: 'user-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  labels: [],
  assignee: { id: 'user-1', email: 'user@example.com', name: 'User' },
  reviewer: null,
  approver: null,
  createdBy: { id: 'user-1', email: 'user@example.com', name: 'User' },
}

const baseCreateBody = {
  title: 'New Card',
  columnId: 'col-1',
  assigneeId: 'user-1',
}

function setupCreateTransactionMock() {
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn({
        ...mockPrisma,
        card: {
          findUnique: mockPrisma.card.findUnique,
          findFirst: mockPrisma.card.findFirst,
          create: mockPrisma.card.create,
        },
      } as unknown as typeof mockPrisma)
    }
  )
}

describe('POST /api/boards/[boardId]/cards — label board-scope (Fix G4.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
    mockPrisma.column.findUnique.mockResolvedValue({ id: 'col-1', boardId: 'board-1' })
    mockPrisma.orgMember.findMany.mockResolvedValue([{ userId: 'user-1' }])
    mockPrisma.card.findFirst.mockResolvedValue(null)
    mockPrisma.card.create.mockResolvedValue(createdCard)
    setupCreateTransactionMock()
  })

  it('POSITIVE: rejects a label from another board with 400', async () => {
    // Two labels requested; only one belongs to board-1.
    mockPrisma.label.findMany.mockResolvedValue([{ id: 'label-board1' }])
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', 'POST', {
      ...baseCreateBody,
      labels: ['label-board1', 'label-other-board'],
    })
    const res = await POST(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('One or more labels do not belong to this board')
    // Must reject before creating the card.
    expect(mockPrisma.card.create).not.toHaveBeenCalled()
  })

  it('NEGATIVE: attaches labels that all belong to the board', async () => {
    mockPrisma.label.findMany.mockResolvedValue([{ id: 'label-1' }, { id: 'label-2' }])
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', 'POST', {
      ...baseCreateBody,
      labels: ['label-1', 'label-2'],
    })
    const res = await POST(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(201)
    expect(mockPrisma.card.create).toHaveBeenCalled()
    // Scope query must be constrained to this board.
    expect(mockPrisma.label.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ boardId: 'board-1' }),
      })
    )
  })

  it('EDGE: duplicate label IDs counted by unique value (single valid label allowed)', async () => {
    // Body has a duplicate; only one distinct id, which exists on the board.
    mockPrisma.label.findMany.mockResolvedValue([{ id: 'label-1' }])
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', 'POST', {
      ...baseCreateBody,
      labels: ['label-1', 'label-1'],
    })
    const res = await POST(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(201)
  })

  it('EDGE: empty labels array skips the scope check and succeeds', async () => {
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', 'POST', {
      ...baseCreateBody,
      labels: [],
    })
    const res = await POST(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(201)
    expect(mockPrisma.label.findMany).not.toHaveBeenCalled()
  })

  it('EDGE: nonexistent label (returns zero) is rejected', async () => {
    mockPrisma.label.findMany.mockResolvedValue([])
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', 'POST', {
      ...baseCreateBody,
      labels: ['ghost-label'],
    })
    const res = await POST(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('One or more labels do not belong to this board')
  })
})

// ─── PATCH /api/cards/[cardId] ────────────────────────────────────────────────

const patchBaseCard = {
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
  aiReviewParams: null,
  board: { orgId: 'org-1' },
  labels: [],
  comments: [],
  assignee: null,
  reviewer: null,
  approver: null,
  createdBy: { id: 'user-1', email: 'user@example.com', name: 'User' },
  column: { id: 'col-1', name: 'Backlog' },
  sprint: null,
}

function setupPatchTransactionMock() {
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn({
        card: {
          update: vi.fn().mockResolvedValue({}),
          findFirst: vi.fn().mockResolvedValue(null),
        },
        cardLabel: {
          deleteMany: vi.fn().mockResolvedValue({}),
          createMany: vi.fn().mockResolvedValue({}),
        },
      } as unknown as typeof mockPrisma)
    }
  )
}

describe('PATCH /api/cards/[cardId] — label board-scope (Fix G4.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
  })

  it('POSITIVE: rejects a label from another board with 400', async () => {
    // resolveCard call — card belongs to board-1 / org-1
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.label.findMany.mockResolvedValue([]) // requested label not on this board
    setupPatchTransactionMock()

    const { PATCH } = await import('../../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', {
      labels: ['label-other-board'],
    })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('One or more labels do not belong to this board')
    // Must reject before opening the write transaction.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('NEGATIVE: attaches labels that all belong to the card\'s board', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      ...patchBaseCard,
      labels: [{ label: { id: 'label-1' } }],
    })
    mockPrisma.label.findMany.mockResolvedValue([{ id: 'label-1' }])
    setupPatchTransactionMock()

    const { PATCH } = await import('../../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', {
      labels: ['label-1'],
    })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    // Scope query derives boardId from the card.
    expect(mockPrisma.label.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ boardId: 'board-1' }),
      })
    )
    expect(mockPrisma.$transaction).toHaveBeenCalled()
  })

  it('EDGE: empty labels array clears labels without a scope query', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...patchBaseCard, labels: [] })
    setupPatchTransactionMock()

    const { PATCH } = await import('../../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { labels: [] })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    expect(mockPrisma.label.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.$transaction).toHaveBeenCalled()
  })

  it('EDGE: duplicate label IDs counted by unique value', async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'card-1',
      columnId: 'col-1',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...patchBaseCard })
    mockPrisma.label.findMany.mockResolvedValue([{ id: 'label-1' }])
    setupPatchTransactionMock()

    const { PATCH } = await import('../../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', {
      labels: ['label-1', 'label-1'],
    })
    const res = await PATCH(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
  })
})
