/**
 * Tests for POST /api/boards/[boardId]/cards — M1 extensions
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
  board: {
    findUnique: vi.fn(),
  },
  card: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  column: {
    findUnique: vi.fn(),
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

function makeRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

const baseCreateBody = {
  title: 'New Card',
  columnId: 'col-1',
  assigneeId: 'user-1',
}

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

function setupHappyPath() {
  mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
  mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  mockPrisma.column.findUnique.mockResolvedValue({ id: 'col-1', boardId: 'board-1' })
  mockPrisma.orgMember.findMany.mockResolvedValue([{ userId: 'user-1' }])
  mockPrisma.card.findFirst.mockResolvedValue(null)
  mockPrisma.card.create.mockResolvedValue(createdCard)
}

// ─── AC-4: assigneeId is required ────────────────────────────────────────────
describe('POST /api/boards/[boardId]/cards — assigneeId required (AC-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  it('returns 400 with exact message when assigneeId is missing', async () => {
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      title: 'A card',
      columnId: 'col-1',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('assigneeId is required')
  })

  it('returns 400 when assigneeId is an empty string', async () => {
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      title: 'A card',
      columnId: 'col-1',
      assigneeId: '',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(400)
  })

  it('succeeds when assigneeId is provided', async () => {
    setupHappyPath()
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', baseCreateBody)
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(201)
  })
})

// ─── Role membership IDOR checks ─────────────────────────────────────────────
describe('POST /api/boards/[boardId]/cards — role membership checks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockPrisma.column.findUnique.mockResolvedValue({ id: 'col-1', boardId: 'board-1' })
    mockPrisma.card.findFirst.mockResolvedValue(null)
  })

  it('returns 400 when reviewerId is not an org member', async () => {
    mockPrisma.orgMember.findMany.mockResolvedValue([{ userId: 'user-1' }])
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      reviewerId: 'outsider-user',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('must be a member of this organization')
  })

  it('returns 400 when approverId is not an org member', async () => {
    mockPrisma.orgMember.findMany.mockResolvedValue([{ userId: 'user-1' }])
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      approverId: 'outsider-approver',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('must be a member of this organization')
  })

  it('returns 400 when assigneeId is not an org member', async () => {
    mockPrisma.orgMember.findMany.mockResolvedValue([])
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      assigneeId: 'outsider-assignee',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('must be a member of this organization')
  })
})

// ─── parentCardId validation ──────────────────────────────────────────────────
describe('POST /api/boards/[boardId]/cards — parentCardId validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockPrisma.column.findUnique.mockResolvedValue({ id: 'col-1', boardId: 'board-1' })
    mockPrisma.orgMember.findMany.mockResolvedValue([{ userId: 'user-1' }])
    mockPrisma.card.findFirst.mockResolvedValue(null)
  })

  it('returns 400 when parentCardId does not exist', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      parentCardId: 'nonexistent',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Parent card not found')
  })

  it('returns 400 when parentCardId is on a different board', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({
      id: 'parent-1',
      boardId: 'other-board',
      path: '',
      depth: 0,
    })
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      parentCardId: 'parent-1',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Parent card must be on the same board')
  })

  it('returns 400 when parent is at depth 50 (cap exceeded)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({
      id: 'parent-deep',
      boardId: 'board-1',
      path: 'long/path/',
      depth: 50,
    })
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      parentCardId: 'parent-deep',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Maximum nesting depth (50) reached')
  })

  it('succeeds when parent is at depth 49 (creates child at depth 50)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({
      id: 'parent-49',
      boardId: 'board-1',
      path: 'long/path/',
      depth: 49,
    })
    mockPrisma.card.create.mockResolvedValue({
      ...createdCard,
      parentCardId: 'parent-49',
      path: 'long/path/parent-49/',
      depth: 50,
    })
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      parentCardId: 'parent-49',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.card.depth).toBe(50)
    expect(body.card.path).toBe('long/path/parent-49/')
  })

  it('creates child card with correct path and depth from root parent', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({
      id: 'parent-root',
      boardId: 'board-1',
      path: '',
      depth: 0,
    })
    mockPrisma.card.create.mockResolvedValue({
      ...createdCard,
      parentCardId: 'parent-root',
      path: 'parent-root/',
      depth: 1,
    })
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      parentCardId: 'parent-root',
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.card.depth).toBe(1)
    expect(body.card.path).toBe('parent-root/')
  })
})

// ─── aiReviewParams round-trip ────────────────────────────────────────────────
describe('POST /api/boards/[boardId]/cards — aiReviewParams', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupHappyPath()
  })

  it('stores as JSON string and returns parsed object', async () => {
    const params = { model: 'claude-sonnet-4-6', rubric: 'Check quality', customInstructions: 'Be brief' }
    mockPrisma.card.create.mockResolvedValue({
      ...createdCard,
      aiReviewParams: JSON.stringify(params),
    })
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      aiReviewParams: params,
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.card.aiReviewParams).toEqual(params)
  })

  it('returns null aiReviewParams when not provided', async () => {
    mockPrisma.card.create.mockResolvedValue({ ...createdCard, aiReviewParams: null })
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', baseCreateBody)
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.card.aiReviewParams).toBeNull()
  })

  it('rejects malformed aiReviewParams (missing rubric)', async () => {
    const { POST } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const req = makeRequest('http://localhost/api/boards/board-1/cards', {
      ...baseCreateBody,
      aiReviewParams: { model: 'claude-sonnet-4-6' },
    })
    const res = await POST(req, { params: { boardId: 'board-1' } })
    expect(res.status).toBe(400)
  })
})
