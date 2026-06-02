/**
 * Tests for GET /api/artifacts/[artifactId]/download
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Readable } from 'node:stream'

const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

const mockPrisma = {
  artifact: { findUnique: vi.fn() },
  orgMember: { findUnique: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

const mockStorage = { put: vi.fn(), getStream: vi.fn(), delete: vi.fn() }
vi.mock('../../src/lib/storage', () => ({ getStorageDriver: () => mockStorage }))

const baseArtifact = {
  id: 'art-1',
  cardId: 'card-1',
  uploaderId: 'user-1',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  storageKey: 'art-1',
  source: 'UPLOAD',
  createdAt: new Date(),
  card: { board: { orgId: 'org-1' } },
}

function makeNodeStream(content: string): Readable {
  return Readable.from([Buffer.from(content)])
}

describe('GET /api/artifacts/[artifactId]/download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
    mockPrisma.artifact.findUnique.mockResolvedValue(baseArtifact)
    mockStorage.getStream.mockResolvedValue(makeNodeStream('pdf bytes'))
  })

  it('streams the file with correct headers', async () => {
    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/download/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/download')
    const res = await GET(req, { params: Promise.resolve({ artifactId: 'art-1' }) })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="report.pdf"')
    expect(res.headers.get('Content-Length')).toBe('1024')
  })

  it('includes X-Content-Type-Options: nosniff header', async () => {
    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/download/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/download')
    const res = await GET(req, { params: Promise.resolve({ artifactId: 'art-1' }) })

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('returns 404 when artifact not found', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue(null)
    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/download/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/download')
    const res = await GET(req, { params: Promise.resolve({ artifactId: 'art-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 404 when artifact belongs to different org', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue({
      ...baseArtifact,
      card: { board: { orgId: 'other-org' } },
    })
    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/download/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/download')
    const res = await GET(req, { params: Promise.resolve({ artifactId: 'art-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns a defined 409 (not 500) for a Google-source artifact', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue({
      ...baseArtifact,
      source: 'GOOGLE_DOC',
      storageKey: 'gdrive://abc123',
    })
    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/download/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/download')
    const res = await GET(req, { params: Promise.resolve({ artifactId: 'art-1' }) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('Artifact is not directly downloadable')
    // Must short-circuit before touching storage (which would throw on the gdrive:// key).
    expect(mockStorage.getStream).not.toHaveBeenCalled()
  })

  it('returns 409 when storageKey has gdrive:// prefix even if source is unset', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue({
      ...baseArtifact,
      source: 'UPLOAD',
      storageKey: 'gdrive://xyz789',
    })
    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/download/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/download')
    const res = await GET(req, { params: Promise.resolve({ artifactId: 'art-1' }) })
    expect(res.status).toBe(409)
    expect(mockStorage.getStream).not.toHaveBeenCalled()
  })

  it('still downloads a normal UPLOAD artifact (negative / false-positive boundary)', async () => {
    // baseArtifact is source UPLOAD with a safe key — must NOT be treated as Google.
    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/download/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/download')
    const res = await GET(req, { params: Promise.resolve({ artifactId: 'art-1' }) })
    expect(res.status).toBe(200)
    expect(mockStorage.getStream).toHaveBeenCalledWith('art-1')
  })

  it('returns 410 when file is missing from storage (ENOENT)', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    mockStorage.getStream.mockResolvedValue(makeNodeStream('pdf bytes'))
    mockStorage.getStream.mockRejectedValue(enoent)
    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/download/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/download')
    const res = await GET(req, { params: Promise.resolve({ artifactId: 'art-1' }) })
    expect(res.status).toBe(410)
  })
})
