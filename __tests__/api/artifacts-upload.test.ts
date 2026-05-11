/**
 * Tests for POST /api/cards/[cardId]/artifacts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session ────────────────────────────────────────────────────────
const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }

vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  card: { findUnique: vi.fn() },
  artifact: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  orgMember: { findUnique: vi.fn() },
}

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

// ─── Mock storage ─────────────────────────────────────────────────────────────
const mockStorage = { put: vi.fn(), getStream: vi.fn(), delete: vi.fn() }
vi.mock('../../src/lib/storage', () => ({ getStorageDriver: () => mockStorage }))

// ─── Mock enqueueAiReview ─────────────────────────────────────────────────────
const mockEnqueue = vi.fn()
vi.mock('../../src/lib/ai-review/queue', () => ({ enqueueAiReview: mockEnqueue }))

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const baseCard = {
  id: 'card-1',
  aiAutoReview: false,
  board: { orgId: 'org-1' },
}

const baseArtifact = {
  id: 'art-1',
  cardId: 'card-1',
  uploaderId: 'user-1',
  filename: 'test.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 100,
  storageKey: 'art-1',
  source: 'UPLOAD',
  createdAt: new Date(),
  uploader: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
  reviews: [],
}

function makeFormDataRequest(file: File): NextRequest {
  const fd = new FormData()
  fd.append('file', file)
  return new NextRequest('http://localhost/api/cards/card-1/artifacts', { method: 'POST', body: fd })
}

function makeFile(name: string, type: string, sizeBytes: number): File {
  const content = new Uint8Array(sizeBytes).fill(65)
  return new File([content], name, { type })
}

describe('POST /api/cards/[cardId]/artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockPrisma.card.findUnique
      .mockResolvedValueOnce(baseCard)        // resolveCard
      .mockResolvedValueOnce(baseCard)        // aiAutoReview re-fetch
    mockPrisma.artifact.create.mockResolvedValue({ ...baseArtifact, storageKey: 'pending' })
    mockPrisma.artifact.update.mockResolvedValue(baseArtifact)
    mockStorage.put.mockResolvedValue({ key: 'art-1' })
    mockEnqueue.mockResolvedValue(undefined)
  })

  it('returns 201 with artifact body on success', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('test.pdf', 'application/pdf', 100))
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.artifact).toMatchObject({
      id: 'art-1',
      filename: 'test.pdf',
      mimeType: 'application/pdf',
      uploader: { id: 'user-1' },
      reviews: [],
    })
  })

  it('returns 415 for disallowed MIME type', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('evil.zip', 'application/zip', 100))
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.error).toBe('Unsupported Media Type')
  })

  it('returns 413 when file exceeds 25 MB', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const oversizeBytes = 25 * 1024 * 1024 + 1
    const req = makeFormDataRequest(makeFile('big.pdf', 'application/pdf', oversizeBytes))
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toBe('Payload Too Large')
  })

  it('returns 400 when file field is missing', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const fd = new FormData()
    fd.append('other', 'value')
    const req = new NextRequest('http://localhost/api/cards/card-1/artifacts', { method: 'POST', body: fd })
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Missing file field')
  })

  it('calls enqueueAiReview when card.aiAutoReview is true', async () => {
    mockPrisma.card.findUnique
      .mockReset()
      .mockResolvedValueOnce({ ...baseCard, aiAutoReview: true })
      .mockResolvedValueOnce({ ...baseCard, aiAutoReview: true })
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    await POST(req, { params: { cardId: 'card-1' } })
    expect(mockEnqueue).toHaveBeenCalledWith('art-1')
  })

  it('does not call enqueueAiReview when card.aiAutoReview is false', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    await POST(req, { params: { cardId: 'card-1' } })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('rolls back DB row and returns 500 when storage write fails', async () => {
    mockStorage.put.mockRejectedValue(new Error('disk full'))
    mockPrisma.artifact.delete.mockResolvedValue({})

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(500)
    expect(mockPrisma.artifact.delete).toHaveBeenCalledWith({ where: { id: 'art-1' } })
  })

  it('returns 404 when card not found', async () => {
    mockPrisma.card.findUnique.mockReset()
    mockPrisma.card.findUnique.mockResolvedValue(null)
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    const res = await POST(req, { params: { cardId: 'nonexistent' } })
    expect(res.status).toBe(404)
  })
})
