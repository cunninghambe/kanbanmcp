/**
 * Tests for POST /api/cards/[cardId]/promote
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

const txMock = {
  card: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
  },
  $executeRaw: vi.fn().mockResolvedValue(0),
}

const mockPrisma = {
  card: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
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

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'POST' })
}

const membership = { userId: 'user-1', orgId: 'org-1', role: 'MEMBER' }

describe('POST /api/cards/[cardId]/promote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    mockSession.orgId = 'org-1'
    Object.assign(mockSession, { isApiKeyAuth: undefined })
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)
    )
    txMock.card.update.mockResolvedValue({})
    txMock.$executeRaw.mockResolvedValue(0)
  })

  it('promotes a nested card to root: returns 200 with updated card', async () => {
    const nestedCard = {
      id: 'card-1',
      parentCardId: 'parent-1',
      path: '/parent-1/',
      depth: 1,
      aiReviewParams: null,
      board: { orgId: 'org-1' },
    }
    const promotedCard = { ...nestedCard, parentCardId: null, path: '', depth: 0 }
    mockPrisma.card.findUnique.mockResolvedValueOnce(nestedCard).mockResolvedValueOnce(promotedCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    txMock.card.findUnique.mockResolvedValue(nestedCard)

    const { POST } = await import('../../src/app/api/cards/[cardId]/promote/route')
    const req = makeRequest('http://localhost/api/cards/card-1/promote')
    const res = await POST(req, { params: { cardId: 'card-1' } })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.card).toBeDefined()
  })

  it('is a no-op when card is already root: returns 200', async () => {
    const rootCard = {
      id: 'card-1',
      parentCardId: null,
      path: '',
      depth: 0,
      aiReviewParams: null,
      board: { orgId: 'org-1' },
    }
    mockPrisma.card.findUnique.mockResolvedValue(rootCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    const { POST } = await import('../../src/app/api/cards/[cardId]/promote/route')
    const req = makeRequest('http://localhost/api/cards/card-1/promote')
    const res = await POST(req, { params: { cardId: 'card-1' } })

    expect(res.status).toBe(200)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns 404 for non-existent card', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    const { POST } = await import('../../src/app/api/cards/[cardId]/promote/route')
    const req = makeRequest('http://localhost/api/cards/nonexistent/promote')
    const res = await POST(req, { params: { cardId: 'nonexistent' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 for cross-org card', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({
      id: 'card-1',
      parentCardId: 'parent-1',
      board: { orgId: 'other-org' },
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    const { POST } = await import('../../src/app/api/cards/[cardId]/promote/route')
    const req = makeRequest('http://localhost/api/cards/card-1/promote')
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(404)
  })

  it('updates parentCardId=null inside transaction', async () => {
    const nestedCard = {
      id: 'card-1',
      parentCardId: 'parent-1',
      path: '/parent-1/',
      depth: 1,
      aiReviewParams: null,
      board: { orgId: 'org-1' },
    }
    const promotedCard = { ...nestedCard, parentCardId: null, path: '', depth: 0 }
    mockPrisma.card.findUnique.mockResolvedValueOnce(nestedCard).mockResolvedValueOnce(promotedCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    txMock.card.findUnique.mockResolvedValue(nestedCard)

    const { POST } = await import('../../src/app/api/cards/[cardId]/promote/route')
    const req = makeRequest('http://localhost/api/cards/card-1/promote')
    await POST(req, { params: { cardId: 'card-1' } })

    expect(mockPrisma.$transaction).toHaveBeenCalled()
    expect(txMock.card.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'card-1' },
        data: { parentCardId: null },
      })
    )
  })
})
