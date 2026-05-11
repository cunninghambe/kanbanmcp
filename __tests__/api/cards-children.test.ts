/**
 * Tests for GET /api/cards/[cardId]/children?depth=N
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
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  orgMember: {
    findUnique: vi.fn(),
  },
  signoff: {
    findMany: vi.fn(),
  },
  apiKey: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
}

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' })
}

const membership = { userId: 'user-1', orgId: 'org-1', role: 'MEMBER' }

const rootCard = {
  id: 'card-root',
  title: 'Root',
  description: null,
  parentCardId: null,
  path: '',
  depth: 0,
  aiAutoReview: false,
  aiReviewParams: null,
  assigneeId: null,
  reviewerId: null,
  approverId: null,
  assignee: null,
  reviewer: null,
  approver: null,
  board: { orgId: 'org-1' },
}

function setupHappyPath(descendants: typeof rootCard[]) {
  mockPrisma.card.findUnique.mockResolvedValue(rootCard)
  mockPrisma.card.findMany.mockResolvedValue(descendants)
  mockPrisma.signoff.findMany.mockResolvedValue([])
  mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
}

describe('GET /api/cards/[cardId]/children', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    mockSession.orgId = 'org-1'
    Object.assign(mockSession, { isApiKeyAuth: undefined })
  })

  it('returns root and empty descendants when card has no children', async () => {
    setupHappyPath([])
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/card-root/children')
    const res = await GET(req, { params: { cardId: 'card-root' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.root.id).toBe('card-root')
    expect(body.descendants).toEqual([])
  })

  it('returns root and descendants', async () => {
    const child = { ...rootCard, id: 'child-1', parentCardId: 'card-root' as unknown as null, path: '/card-root/', depth: 1 }
    setupHappyPath([child])
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/card-root/children?depth=1')
    const res = await GET(req, { params: { cardId: 'card-root' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.root.id).toBe('card-root')
    expect(body.descendants).toHaveLength(1)
    expect(body.descendants[0].id).toBe('child-1')
  })

  it('clamps depth>5 to 5 (not rejected)', async () => {
    setupHappyPath([])
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/card-root/children?depth=999')
    const res = await GET(req, { params: { cardId: 'card-root' } })
    expect(res.status).toBe(200)
    expect(mockPrisma.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ depth: { lte: 5 } }) })
    )
  })

  it('clamps depth<1 to 1', async () => {
    setupHappyPath([])
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/card-root/children?depth=-1')
    const res = await GET(req, { params: { cardId: 'card-root' } })
    expect(res.status).toBe(200)
    expect(mockPrisma.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ depth: { lte: 1 } }) })
    )
  })

  it('defaults depth=1 when not provided', async () => {
    setupHappyPath([])
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/card-root/children')
    await GET(req, { params: { cardId: 'card-root' } })
    expect(mockPrisma.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ depth: { lte: 1 } }) })
    )
  })

  it('returns 404 for non-existent card', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/nonexistent/children')
    const res = await GET(req, { params: { cardId: 'nonexistent' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 for cross-org card (not 403)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ ...rootCard, board: { orgId: 'other-org' } })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/card-root/children')
    const res = await GET(req, { params: { cardId: 'card-root' } })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Card not found')
  })

  it('uses subtree LIKE query with correct path prefix', async () => {
    setupHappyPath([])
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/card-root/children?depth=2')
    await GET(req, { params: { cardId: 'card-root' } })
    expect(mockPrisma.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ path: { startsWith: '/card-root/' } }),
      })
    )
  })

  it('includes signoffs in each node', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(rootCard)
    mockPrisma.card.findMany.mockResolvedValue([])
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    mockPrisma.signoff.findMany.mockResolvedValue([
      {
        id: 'sig-1',
        cardId: 'card-root',
        role: 'REVIEWER',
        decision: 'APPROVED',
        createdAt: new Date('2026-01-01'),
        user: { id: 'u1', name: 'Alice', email: 'alice@example.com' },
      },
    ])
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/card-root/children')
    const res = await GET(req, { params: { cardId: 'card-root' } })
    const body = await res.json()
    expect(body.root.signoffs.reviewer).toMatchObject({ id: 'sig-1', decision: 'APPROVED' })
    expect(body.root.signoffs.approver).toBeNull()
  })

  it('depth=0 returns root only with no findMany call (AC-8)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(rootCard)
    mockPrisma.signoff.findMany.mockResolvedValue([])
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    const { GET } = await import('../../src/app/api/cards/[cardId]/children/route')
    const req = makeRequest('http://localhost/api/cards/card-root/children?depth=0')
    const res = await GET(req, { params: { cardId: 'card-root' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.root.id).toBe('card-root')
    expect(body.descendants).toEqual([])
    expect(mockPrisma.card.findMany).not.toHaveBeenCalled()
  })
})
