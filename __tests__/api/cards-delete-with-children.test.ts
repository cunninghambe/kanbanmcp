/**
 * Tests for DELETE /api/cards/[cardId] with children (eager subtree recompute)
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
  },
  $executeRaw: vi.fn().mockResolvedValue(0),
}

const mockPrisma = {
  card: {
    findUnique: vi.fn(),
    delete: vi.fn().mockResolvedValue({}),
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

function makeDeleteRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'DELETE' })
}

const membership = { userId: 'user-1', orgId: 'org-1', role: 'MEMBER' }

describe('DELETE /api/cards/[cardId] with children', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    mockSession.orgId = 'org-1'
    Object.assign(mockSession, { isApiKeyAuth: undefined })
    txMock.card.update.mockResolvedValue({})
    txMock.$executeRaw.mockResolvedValue(0)
    mockPrisma.card.delete.mockResolvedValue({})
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)
    )
  })

  it('deletes card and recomputes children paths to root', async () => {
    const parent = {
      id: 'parent-1',
      board: { orgId: 'org-1' },
      children: [{ id: 'child-A' }, { id: 'child-B' }],
    }
    const childA = { id: 'child-A', path: '/parent-1/', depth: 1 }
    const childB = { id: 'child-B', path: '/parent-1/', depth: 1 }

    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'parent-1', board: { orgId: 'org-1' } })
      .mockResolvedValueOnce(parent)

    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    txMock.card.findUnique
      .mockResolvedValueOnce(childA)
      .mockResolvedValueOnce(childB)

    const { DELETE } = await import('../../src/app/api/cards/[cardId]/route')
    const req = makeDeleteRequest('http://localhost/api/cards/parent-1')
    const res = await DELETE(req, { params: { cardId: 'parent-1' } })

    expect(res.status).toBe(200)
    expect(mockPrisma.card.delete).toHaveBeenCalledWith({ where: { id: 'parent-1' } })
    expect(txMock.card.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'child-A' },
        data: { path: '', depth: 0 },
      })
    )
    expect(txMock.card.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'child-B' },
        data: { path: '', depth: 0 },
      })
    )
  })

  it('deletes card with no children successfully', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'solo-card', board: { orgId: 'org-1' } })
      .mockResolvedValueOnce({ id: 'solo-card', board: { orgId: 'org-1' }, children: [] })

    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)

    const { DELETE } = await import('../../src/app/api/cards/[cardId]/route')
    const req = makeDeleteRequest('http://localhost/api/cards/solo-card')
    const res = await DELETE(req, { params: { cardId: 'solo-card' } })

    expect(res.status).toBe(200)
    expect(mockPrisma.card.delete).toHaveBeenCalledWith({ where: { id: 'solo-card' } })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns 500 when delete throws', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1', board: { orgId: 'org-1' } })
      .mockResolvedValueOnce({ id: 'card-1', board: { orgId: 'org-1' }, children: [] })

    mockPrisma.orgMember.findUnique.mockResolvedValue(membership)
    mockPrisma.card.delete.mockRejectedValue(new Error('DB error'))

    const { DELETE } = await import('../../src/app/api/cards/[cardId]/route')
    const req = makeDeleteRequest('http://localhost/api/cards/card-1')
    const res = await DELETE(req, { params: { cardId: 'card-1' } })

    expect(res.status).toBe(500)
  })
})
