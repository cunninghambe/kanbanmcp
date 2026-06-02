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
  orgMember: { findUnique: vi.fn(), findFirst: vi.fn() },
}

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

// ─── Mock storage ─────────────────────────────────────────────────────────────
const mockStorage = { put: vi.fn(), getStream: vi.fn(), delete: vi.fn() }
vi.mock('../../src/lib/storage', () => ({ getStorageDriver: () => mockStorage }))

// ─── Mock enqueueAiReview ─────────────────────────────────────────────────────
const mockEnqueue = vi.fn()
vi.mock('../../src/lib/ai-review/queue', () => ({ enqueueAiReview: mockEnqueue }))

// ─── Mock api-helpers (allows isApiKeyAuth session override) ──────────────────
const mockRequireSession = vi.fn()
const mockRequireOrgRole = vi.fn()
const mockApiError = vi.fn((status: number, msg: string) => {
  const { NextResponse } = require('next/server')
  return NextResponse.json({ error: msg }, { status })
})

vi.mock('../../src/lib/api-helpers', () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
  requireOrgRole: (...args: unknown[]) => mockRequireOrgRole(...args),
  apiError: (status: number, msg: string) => mockApiError(status, msg),
}))

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
  return new NextRequest('http://localhost/api/cards/card-1/artifacts', {
    method: 'POST',
    body: fd,
  })
}

function makeFile(name: string, type: string, sizeBytes: number): File {
  const content = new Uint8Array(sizeBytes).fill(65)
  return new File([content], name, { type })
}

describe('POST /api/cards/[cardId]/artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: normal session (not API key)
    mockRequireSession.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', isApiKeyAuth: false })
    mockRequireOrgRole.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockApiError.mockImplementation((status: number, msg: string) => {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: msg }, { status })
    })
    mockPrisma.card.findUnique
      .mockResolvedValueOnce(baseCard) // resolveCard
      .mockResolvedValueOnce(baseCard) // aiAutoReview re-fetch
    mockPrisma.artifact.create.mockResolvedValue({ ...baseArtifact, storageKey: 'pending' })
    mockPrisma.artifact.update.mockResolvedValue(baseArtifact)
    mockStorage.put.mockResolvedValue({ key: 'art-1' })
    mockEnqueue.mockResolvedValue(undefined)
  })

  it('returns 201 with artifact body on success', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('test.pdf', 'application/pdf', 100))
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
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
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.error).toBe('Unsupported Media Type')
  })

  it('returns 415 for text/html (removed wildcard allows only explicit text types)', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('page.html', 'text/html', 100))
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.error).toBe('Unsupported Media Type')
  })

  it('returns 413 when file exceeds 25 MB', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const oversizeBytes = 25 * 1024 * 1024 + 1
    const req = makeFormDataRequest(makeFile('big.pdf', 'application/pdf', oversizeBytes))
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toBe('Payload Too Large')
  })

  it('returns 413 via Content-Length pre-check before formData is parsed', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const oversizeBytes = 25 * 1024 * 1024 + 1
    const req = new NextRequest('http://localhost/api/cards/card-1/artifacts', {
      method: 'POST',
      headers: { 'content-length': String(oversizeBytes) },
      body: new Uint8Array(0),
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toBe('Payload Too Large')
    // Card lookup happens after the pre-check, so it must not have been called
    expect(mockPrisma.card.findUnique).not.toHaveBeenCalled()
  })

  it('returns 413 for a chunked (no Content-Length) body that streams over the cap', async () => {
    // Simulate a chunked upload: a ReadableStream body, NO content-length header.
    // The fast-path CL check cannot fire, so the route must count actual bytes
    // and abort once cumulative bytes exceed MAX_ARTIFACT_BYTES — before
    // buffering the whole body (the OOM vector).
    const chunkSize = 4 * 1024 * 1024 // 4 MB chunks
    // Far more chunks than the cap needs (80 MB vs 25 MB), so an early abort is
    // unambiguous: the reader must cancel ~7 chunks in. `produced` counts chunks
    // the source ENQUEUED; a ReadableStream pulls ~1 ahead, so we assert it
    // stopped well before exhausting the stream rather than an exact count.
    const chunkCount = 20 // 80 MB total ≫ 25 MB cap
    let produced = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= chunkCount) {
          controller.close()
          return
        }
        produced += 1
        controller.enqueue(new Uint8Array(chunkSize).fill(65))
      },
    })

    const req = new NextRequest('http://localhost/api/cards/card-1/artifacts', {
      method: 'POST',
      // multipart content-type so the route does not reject on a missing boundary
      // before the size check — though the size check fires first regardless.
      headers: { 'content-type': 'multipart/form-data; boundary=----test' },
      body: stream,
      duplex: 'half',
    })

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toBe('Payload Too Large')
    // The whole stream must NOT have been buffered: production stopped early.
    expect(produced).toBeLessThan(chunkCount)
    // No artifact row created for an over-limit upload.
    expect(mockPrisma.artifact.create).not.toHaveBeenCalled()
  })

  it('still succeeds for an under-limit chunked body (negative / false-positive boundary)', async () => {
    // A small chunked body (no content-length) must parse normally and 201.
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('small.pdf', 'application/pdf', 256))
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(201)
    expect(mockPrisma.artifact.create).toHaveBeenCalled()
  })

  it('returns 400 when file field is missing', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const fd = new FormData()
    fd.append('other', 'value')
    const req = new NextRequest('http://localhost/api/cards/card-1/artifacts', {
      method: 'POST',
      body: fd,
    })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Missing file field')
  })

  it('calls enqueueAiReview when card.aiAutoReview is true', async () => {
    mockPrisma.card.findUnique
      .mockReset()
      .mockResolvedValueOnce({ ...baseCard, aiAutoReview: true })
      .mockResolvedValueOnce({ ...baseCard, aiAutoReview: true })

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(mockEnqueue).toHaveBeenCalledWith('art-1')
  })

  it('does not call enqueueAiReview when card.aiAutoReview is false', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('rolls back DB row and returns 500 when storage write fails', async () => {
    mockStorage.put.mockRejectedValue(new Error('disk full'))
    mockPrisma.artifact.delete.mockResolvedValue({})

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(500)
    expect(mockPrisma.artifact.delete).toHaveBeenCalledWith({ where: { id: 'art-1' } })
  })

  it('returns 404 when card not found', async () => {
    mockPrisma.card.findUnique.mockReset()
    mockPrisma.card.findUnique.mockResolvedValue(null)
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    const res = await POST(req, { params: Promise.resolve({ cardId: 'nonexistent' }) })
    expect(res.status).toBe(404)
  })

  it('API-key auth: attributes upload to first org ADMIN', async () => {
    mockRequireSession.mockResolvedValue({ userId: '', orgId: 'org-1', isApiKeyAuth: true })
    mockPrisma.orgMember.findFirst.mockResolvedValue({ userId: 'admin-1' })
    const adminArtifact = {
      ...baseArtifact,
      uploaderId: 'admin-1',
      uploader: { id: 'admin-1', name: 'Admin', email: 'admin@example.com' },
    }
    mockPrisma.artifact.create.mockResolvedValue({ ...adminArtifact, storageKey: 'pending' })
    mockPrisma.artifact.update.mockResolvedValue(adminArtifact)

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(201)
    expect(mockPrisma.orgMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ role: 'ADMIN' }) })
    )
    const body = await res.json()
    expect(body.artifact.uploader.id).toBe('admin-1')
  })

  it('API-key auth: returns 500 when no org admin exists', async () => {
    mockRequireSession.mockResolvedValue({ userId: '', orgId: 'org-1', isApiKeyAuth: true })
    mockPrisma.orgMember.findFirst.mockResolvedValue(null)

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const req = makeFormDataRequest(makeFile('doc.pdf', 'application/pdf', 100))
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/admin/)
  })
})
