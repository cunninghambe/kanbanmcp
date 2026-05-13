/**
 * Tests for GET /api/me/assignments
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
  card: {
    findMany: vi.fn(),
  },
  orgMember: {
    findUnique: vi.fn(),
  },
}

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeCard(overrides: {
  id?: string
  dueDate?: Date | null
  signoffs?: { role: string; decision: string; createdAt: Date }[]
  board?: { name: string; orgId: string }
  column?: { name: string }
}) {
  return {
    id: overrides.id ?? 'card-1',
    title: 'Test Card',
    boardId: 'board-1',
    priority: 'medium',
    dueDate: overrides.dueDate ?? null,
    board: overrides.board ?? { name: 'Board 1', orgId: 'org-1' },
    column: overrides.column ?? { name: 'In Progress' },
    signoffs: overrides.signoffs ?? [],
  }
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/me/assignments', { method: 'GET' })
}

describe('GET /api/me/assignments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    mockSession.orgId = 'org-1'
    Object.assign(mockSession, { isApiKeyAuth: undefined, agentName: undefined })
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
  })

  it('returns 401 for requests with no valid session (e.g. API key callers)', async () => {
    Object.assign(mockSession, { userId: '' })
    const { GET } = await import('../../src/app/api/me/assignments/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns empty categories when user has no assignments', async () => {
    mockPrisma.card.findMany.mockResolvedValue([])
    const { GET } = await import('../../src/app/api/me/assignments/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.asAssignee).toHaveLength(0)
    expect(body.asReviewer).toHaveLength(0)
    expect(body.asApprover).toHaveLength(0)
    expect(body.overdue).toHaveLength(0)
  })

  it('populates asAssignee and separates overdue cards', async () => {
    const pastDate = new Date(Date.now() - 86400_000)
    const futureDate = new Date(Date.now() + 86400_000)

    const overdueCard = makeCard({ id: 'card-overdue', dueDate: pastDate })
    const normalCard = makeCard({ id: 'card-normal', dueDate: futureDate })

    // findMany called 3 times: assignee, reviewer, approver
    mockPrisma.card.findMany
      .mockResolvedValueOnce([overdueCard, normalCard]) // assignee
      .mockResolvedValueOnce([]) // reviewer
      .mockResolvedValueOnce([]) // approver

    const { GET } = await import('../../src/app/api/me/assignments/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.overdue).toHaveLength(1)
    expect(body.overdue[0].id).toBe('card-overdue')
    expect(body.asAssignee).toHaveLength(1)
    expect(body.asAssignee[0].id).toBe('card-normal')
  })

  it('includes reviewer card when no signoffs exist', async () => {
    const reviewerCard = makeCard({ id: 'card-review', signoffs: [] })

    mockPrisma.card.findMany
      .mockResolvedValueOnce([]) // assignee
      .mockResolvedValueOnce([reviewerCard]) // reviewer
      .mockResolvedValueOnce([]) // approver

    const { GET } = await import('../../src/app/api/me/assignments/route')
    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.asReviewer).toHaveLength(1)
    expect(body.asReviewer[0].id).toBe('card-review')
  })

  it('includes reviewer card when latest signoff is REQUESTED_CHANGES', async () => {
    const signoffs = [
      { role: 'REVIEWER', decision: 'REQUESTED_CHANGES', createdAt: new Date() },
    ]
    const card = makeCard({ id: 'card-changes', signoffs })

    mockPrisma.card.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([card])
      .mockResolvedValueOnce([])

    const { GET } = await import('../../src/app/api/me/assignments/route')
    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.asReviewer).toHaveLength(1)
  })

  it('excludes reviewer card when latest signoff is APPROVED', async () => {
    const signoffs = [
      { role: 'REVIEWER', decision: 'APPROVED', createdAt: new Date() },
    ]
    const card = makeCard({ id: 'card-approved', signoffs })

    mockPrisma.card.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([card])
      .mockResolvedValueOnce([])

    const { GET } = await import('../../src/app/api/me/assignments/route')
    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.asReviewer).toHaveLength(0)
  })

  it('includes approver card when latest signoff is REQUESTED_CHANGES', async () => {
    const signoffs = [
      { role: 'APPROVER', decision: 'REQUESTED_CHANGES', createdAt: new Date() },
    ]
    const card = makeCard({ id: 'card-approver-changes', signoffs })

    mockPrisma.card.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([card])

    const { GET } = await import('../../src/app/api/me/assignments/route')
    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.asApprover).toHaveLength(1)
  })

  it('excludes approver card when latest signoff is APPROVED', async () => {
    const signoffs = [
      { role: 'APPROVER', decision: 'APPROVED', createdAt: new Date() },
    ]
    const card = makeCard({ id: 'card-approver-ok', signoffs })

    mockPrisma.card.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([card])

    const { GET } = await import('../../src/app/api/me/assignments/route')
    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.asApprover).toHaveLength(0)
  })

  it('shapes returned cards correctly', async () => {
    const card = makeCard({
      id: 'shaped-card',
      board: { name: 'My Board', orgId: 'org-1' },
      column: { name: 'In Review' },
    })

    mockPrisma.card.findMany
      .mockResolvedValueOnce([card])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const { GET } = await import('../../src/app/api/me/assignments/route')
    const res = await GET(makeRequest())
    const body = await res.json()
    const c = body.asAssignee[0]
    expect(c.id).toBe('shaped-card')
    expect(c.boardName).toBe('My Board')
    expect(c.columnName).toBe('In Review')
    expect(c.priority).toBe('medium')
    expect(c.hasOpenReviews).toBe(false)
  })
})
