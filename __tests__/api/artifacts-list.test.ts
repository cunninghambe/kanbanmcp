/**
 * Tests for GET /api/cards/[cardId]/artifacts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

const mockPrisma = {
  card: { findUnique: vi.fn() },
  artifact: { findMany: vi.fn() },
  orgMember: { findUnique: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

const baseCard = { id: 'card-1', board: { orgId: 'org-1' } }

function makeArtifact(id: string, createdAt: Date) {
  return {
    id,
    cardId: 'card-1',
    uploaderId: 'user-1',
    filename: `file-${id}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 512,
    storageKey: id,
    source: 'UPLOAD',
    createdAt,
    uploader: {
      id: 'user-1',
      name: 'Alice',
      email: 'alice@example.com',
      passwordHash: 'h',
      isAgent: false,
      createdAt: new Date(),
    },
    reviews: [],
  }
}

describe('GET /api/cards/[cardId]/artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
    mockPrisma.card.findUnique.mockResolvedValue(baseCard)
  })

  it('returns artifacts ordered by createdAt DESC', async () => {
    const older = makeArtifact('art-1', new Date('2024-01-01'))
    const newer = makeArtifact('art-2', new Date('2024-02-01'))
    // DB returns in desc order already (mocked), mirroring what the query requests
    mockPrisma.artifact.findMany.mockResolvedValue([newer, older])

    const { GET } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/artifacts', { method: 'GET' })
    const res = await GET(req, { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.artifacts).toHaveLength(2)
    expect(body.artifacts[0].id).toBe('art-2')
    expect(body.artifacts[1].id).toBe('art-1')
  })

  it('returns empty array when card has no artifacts', async () => {
    mockPrisma.artifact.findMany.mockResolvedValue([])
    const { GET } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/artifacts', { method: 'GET' })
    const res = await GET(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.artifacts).toEqual([])
  })

  it('includes uploader and reviews in response shape', async () => {
    const art = makeArtifact('art-3', new Date())
    mockPrisma.artifact.findMany.mockResolvedValue([art])
    const { GET } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/artifacts', { method: 'GET' })
    const res = await GET(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    const body = await res.json()
    const a = body.artifacts[0]
    expect(a).toHaveProperty('uploader')
    expect(a).toHaveProperty('reviews')
    expect(a.uploader).toMatchObject({ id: 'user-1', name: 'Alice', email: 'alice@example.com' })
  })

  it('returns 404 when card not found', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    const { GET } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/artifacts', { method: 'GET' })
    const res = await GET(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(404)
  })
})
