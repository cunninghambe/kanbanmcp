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
  },
  $transaction: vi.fn(),
}

vi.mock('../src/lib/db', () => ({
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
  priority: "none",
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
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  it('returns 404 when card not found', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    const { GET } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/nonexistent', 'GET')
    const res = await GET(req, { params: { cardId: 'nonexistent' } })
    expect(res.status).toBe(404)
  })

  it('returns 403 when card belongs to different org', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({
      ...baseCard,
      board: { orgId: 'other-org' },
    })
    const { GET } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'GET')
    const res = await GET(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(403)
  })

  it('returns card details on success', async () => {
    // First call: resolveCard
    mockPrisma.card.findUnique.mockResolvedValueOnce({ id: 'card-1', board: { orgId: 'org-1' } })
    // Second call: full card fetch
    mockPrisma.card.findUnique.mockResolvedValueOnce(baseCard)
    const { GET } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'GET')
    const res = await GET(req, { params: { cardId: 'card-1' } })
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
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  it('returns 400 for empty title', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ ...baseCard })
    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { title: '' })
    const res = await PATCH(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(400)
  })

  it('updates card title successfully', async () => {
    // resolveCard call
    mockPrisma.card.findUnique.mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', boardId: 'board-1', board: { orgId: 'org-1' } })
    // final fetch after update
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, title: 'Updated Title' })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn({
        card: { update: vi.fn().mockResolvedValue({}) },
        cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
      } as unknown as typeof mockPrisma)
    })
    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { title: 'Updated Title' })
    const res = await PATCH(req, { params: { cardId: 'card-1' } })
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
    mockPrisma.card.findFirst.mockResolvedValue({ position: 2 })
    mockPrisma.card.findMany.mockResolvedValue([])
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn({
        card: { update: vi.fn().mockResolvedValue({}) },
        cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
      } as unknown as typeof mockPrisma)
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, columnId: 'col-2' })

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'PATCH', { columnId: 'col-2' })
    const res = await PATCH(req, { params: { cardId: 'card-1' } })
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
    const res = await PATCH(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('sibling card IDs')
  })
})

// ─── DELETE /api/cards/[cardId] ───────────────────────────────────────────────
describe('DELETE /api/cards/[cardId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  it('deletes card and returns success', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ id: 'card-1', board: { orgId: 'org-1' } })
    mockPrisma.card.delete.mockResolvedValue({})
    const { DELETE } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'DELETE')
    const res = await DELETE(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('returns 404 when card not found', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    const { DELETE } = await import('../src/app/api/cards/[cardId]/route')
    const req = makeRequest('http://localhost/api/cards/card-1', 'DELETE')
    const res = await DELETE(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(404)
  })
})


// ─── Priority field tests ─────────────────────────────────────────────────────
describe("PATCH /api/cards/[cardId] - priority field", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: "user-1", orgId: "org-1", role: "MEMBER" })
  })

  it("accepts valid priority values", async () => {
    const validPriorities = ["none", "low", "medium", "high", "critical"]
    for (const priority of validPriorities) {
      vi.clearAllMocks()
      mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: "user-1", orgId: "org-1", role: "MEMBER" })
      mockPrisma.card.findUnique.mockResolvedValueOnce({
        id: "card-1", columnId: "col-1", boardId: "board-1", board: { orgId: "org-1" },
      })
      mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, priority })
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          card: { update: vi.fn().mockResolvedValue({}) },
          cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
        } as unknown as typeof mockPrisma)
      })
      const { PATCH } = await import("../src/app/api/cards/[cardId]/route")
      const req = makeRequest("http://localhost/api/cards/card-1", "PATCH", { priority })
      const res = await PATCH(req, { params: { cardId: "card-1" } })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.card.priority).toBe(priority)
    }
  })

  it("rejects invalid priority value", async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: "card-1", columnId: "col-1", boardId: "board-1", board: { orgId: "org-1" },
    })
    const { PATCH } = await import("../src/app/api/cards/[cardId]/route")
    const req = makeRequest("http://localhost/api/cards/card-1", "PATCH", { priority: "urgent" })
    const res = await PATCH(req, { params: { cardId: "card-1" } })
    expect(res.status).toBe(400)
  })

  it("does not clobber existing priority when priority absent from body", async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: "card-1", columnId: "col-1", boardId: "board-1", board: { orgId: "org-1" },
    })
    mockPrisma.card.findUnique.mockResolvedValueOnce({ ...baseCard, priority: "high", title: "New Title" })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn({
        card: { update: vi.fn().mockResolvedValue({}) },
        cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
        orgMember: { findUnique: vi.fn().mockResolvedValue({ userId: "user-1", orgId: "org-1" }) },
      } as unknown as typeof mockPrisma)
    })
    const { PATCH } = await import("../src/app/api/cards/[cardId]/route")
    // Send only title, no priority field
    const req = makeRequest("http://localhost/api/cards/card-1", "PATCH", { title: "New Title" })
    const res = await PATCH(req, { params: { cardId: "card-1" } })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Priority should remain "high" (not overwritten)
    expect(body.card.priority).toBe("high")
  })
})

// ─── Assignee IDOR protection ─────────────────────────────────────────────────
describe("PATCH /api/cards/[cardId] - assignee IDOR protection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: "user-1", orgId: "org-1", role: "MEMBER" })
  })

  it("rejects assigneeId from a different org", async () => {
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: "card-1", columnId: "col-1", boardId: "board-1", board: { orgId: "org-1" },
    })
    // IDOR check: findUnique for org membership returns null (user not in this org)
    mockPrisma.orgMember.findUnique
      .mockResolvedValueOnce({ userId: "user-1", orgId: "org-1", role: "MEMBER" }) // requireOrgRole
      .mockResolvedValueOnce(null) // assigneeId membership check fails

    const { PATCH } = await import("../src/app/api/cards/[cardId]/route")
    const req = makeRequest("http://localhost/api/cards/card-1", "PATCH", { assigneeId: "user-from-other-org" })
    const res = await PATCH(req, { params: { cardId: "card-1" } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("member of this organization")
  })
})
