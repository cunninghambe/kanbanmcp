/**
 * Tests for DELETE /api/artifacts/[artifactId]
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

const mockPrisma = {
  artifact: { findUnique: vi.fn(), delete: vi.fn() },
  aiReview: { deleteMany: vi.fn() },
  orgMember: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

const mockStorage = { put: vi.fn(), getStream: vi.fn(), delete: vi.fn() }
vi.mock('../../src/lib/storage', () => ({ getStorageDriver: () => mockStorage }))

const baseArtifact = {
  id: 'art-1',
  cardId: 'card-1',
  uploaderId: 'user-1',
  storageKey: 'art-1',
  card: { board: { orgId: 'org-1' } },
}

describe('DELETE /api/artifacts/[artifactId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.artifact.findUnique.mockResolvedValue(baseArtifact)
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<void>) => fn(mockPrisma))
    mockPrisma.aiReview.deleteMany.mockResolvedValue({ count: 0 })
    mockPrisma.artifact.delete.mockResolvedValue({})
    mockStorage.delete.mockResolvedValue(undefined)
  })

  it('allows uploader to delete — returns 204', async () => {
    // user-1 is the uploader; set MEMBER role (not admin)
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })

    const { DELETE } = await import('../../src/app/api/artifacts/[artifactId]/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1', { method: 'DELETE' })
    const res = await DELETE(req, { params: { artifactId: 'art-1' } })
    expect(res.status).toBe(204)
  })

  it('allows admin to delete another user\'s artifact', async () => {
    const artifactByOther = { ...baseArtifact, uploaderId: 'user-2' }
    mockPrisma.artifact.findUnique.mockResolvedValue(artifactByOther)
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'ADMIN' })

    const { DELETE } = await import('../../src/app/api/artifacts/[artifactId]/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1', { method: 'DELETE' })
    const res = await DELETE(req, { params: { artifactId: 'art-1' } })
    expect(res.status).toBe(204)
  })

  it('denies non-uploader non-admin member — returns 403', async () => {
    const artifactByOther = { ...baseArtifact, uploaderId: 'user-2' }
    mockPrisma.artifact.findUnique.mockResolvedValue(artifactByOther)
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })

    const { DELETE } = await import('../../src/app/api/artifacts/[artifactId]/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1', { method: 'DELETE' })
    const res = await DELETE(req, { params: { artifactId: 'art-1' } })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/uploader or an org admin/)
  })

  it('storage delete failure does not prevent 204 response', async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'ADMIN' })
    mockStorage.delete.mockRejectedValue(new Error('storage unavailable'))

    const { DELETE } = await import('../../src/app/api/artifacts/[artifactId]/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1', { method: 'DELETE' })
    const res = await DELETE(req, { params: { artifactId: 'art-1' } })
    expect(res.status).toBe(204)
  })

  it('returns 404 when artifact not found', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue(null)
    const { DELETE } = await import('../../src/app/api/artifacts/[artifactId]/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1', { method: 'DELETE' })
    const res = await DELETE(req, { params: { artifactId: 'art-1' } })
    expect(res.status).toBe(404)
  })

  it('returns 403 when artifact belongs to different org', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue({
      ...baseArtifact,
      card: { board: { orgId: 'other-org' } },
    })
    const { DELETE } = await import('../../src/app/api/artifacts/[artifactId]/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1', { method: 'DELETE' })
    const res = await DELETE(req, { params: { artifactId: 'art-1' } })
    expect(res.status).toBe(403)
  })
})
