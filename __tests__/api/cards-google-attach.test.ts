/**
 * Tests for POST /api/cards/[cardId]/artifacts/google
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Session mock ────────────────────────────────────────────────────────────

vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue({ userId: 'user-1', orgId: 'org-1' }) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

// ─── Prisma mock ──────────────────────────────────────────────────────────────

const mockPrisma = {
  card: { findUnique: vi.fn() },
  artifact: { create: vi.fn() },
  orgMember: { findFirst: vi.fn() },
  googleCredential: { findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

// ─── API helpers mock ─────────────────────────────────────────────────────────

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

// ─── Drive mock ───────────────────────────────────────────────────────────────

const mockParseDriveUrl = vi.fn()
const mockGetFileMeta = vi.fn()
const mockListFolderRecursive = vi.fn()

vi.mock('../../src/lib/google/drive', () => ({
  parseDriveUrl: (...args: unknown[]) => mockParseDriveUrl(...args),
  getFileMeta: (...args: unknown[]) => mockGetFileMeta(...args),
  listFolderRecursive: (...args: unknown[]) => mockListFolderRecursive(...args),
}))

// ─── AI review queue mock ─────────────────────────────────────────────────────

const mockEnqueue = vi.fn()

vi.mock('../../src/lib/ai-review/queue', () => ({ enqueueAiReview: mockEnqueue }))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseCard = { id: 'card-1', aiAutoReview: false, board: { orgId: 'org-1' } }

const baseUploader = { id: 'user-1', name: 'Alice', email: 'alice@example.com' }

function makeArtifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'art-1',
    cardId: 'card-1',
    uploaderId: 'user-1',
    filename: 'My Doc',
    mimeType: 'application/vnd.google-apps.document',
    sizeBytes: 0,
    storageKey: 'gdrive://file-id-1',
    source: 'GOOGLE_DOC',
    parentArtifactId: null,
    createdAt: new Date(),
    uploader: baseUploader,
    reviews: [],
    ...overrides,
  }
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/cards/card-1/artifacts/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function setupTransaction(folderRow: ReturnType<typeof makeArtifact>, fileRows: ReturnType<typeof makeArtifact>[]) {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
    let callCount = 0
    const fakeTx = {
      artifact: {
        create: vi.fn().mockImplementation(() => {
          if (callCount === 0) { callCount++; return Promise.resolve(folderRow) }
          const row = fileRows[callCount - 1]
          callCount++
          return Promise.resolve(row)
        }),
      },
    }
    const result = await fn(fakeTx as unknown as typeof mockPrisma)
    return result
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/cards/[cardId]/artifacts/google', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireSession.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', isApiKeyAuth: false })
    mockRequireOrgRole.mockResolvedValue(null)
    mockApiError.mockImplementation((status: number, msg: string) => {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: msg }, { status })
    })
    mockPrisma.card.findUnique.mockResolvedValue(baseCard)
    mockPrisma.googleCredential.findUnique.mockResolvedValue({ userId: 'user-1' })
    mockPrisma.googleCredential.update.mockResolvedValue({})
    mockParseDriveUrl.mockReturnValue({ kind: 'file', id: 'file-id-1' })
    mockGetFileMeta.mockResolvedValue({
      id: 'file-id-1',
      name: 'My Doc',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })
    mockPrisma.artifact.create.mockResolvedValue(makeArtifact())
    mockEnqueue.mockResolvedValue(undefined)
  })

  // ── E1 / AC-13: no GoogleCredential → 401 NOT_CONNECTED ────────────────────

  it('E1/AC-13: returns 401 NOT_CONNECTED when user has no GoogleCredential', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(null)
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://docs.google.com/document/d/abc' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('NOT_CONNECTED')
    expect(mockGetFileMeta).not.toHaveBeenCalled()
    expect(mockListFolderRecursive).not.toHaveBeenCalled()
  })

  // ── E3: parseDriveUrl returns null → 400 INVALID_URL ───────────────────────

  it('E3: returns 400 INVALID_URL when parseDriveUrl returns null', async () => {
    mockParseDriveUrl.mockReturnValue(null)
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://example.com/not-drive' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('INVALID_URL')
    expect(mockGetFileMeta).not.toHaveBeenCalled()
  })

  // ── 400 INVALID_URL when body has no url field ──────────────────────────────

  it('returns 400 INVALID_URL when body is missing url field', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({}), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('INVALID_URL')
  })

  // ── E4 / AC-9: DriveTrashedError → 404 TRASHED ─────────────────────────────

  it('E4/AC-9: returns 404 TRASHED when getFileMeta throws DriveTrashedError', async () => {
    const { DriveTrashedError } = await import('../../src/lib/google/errors')
    mockGetFileMeta.mockRejectedValue(new DriveTrashedError())
    mockParseDriveUrl.mockReturnValue({ kind: 'file', id: 'file-id-1' })
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://docs.google.com/document/d/abc' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('TRASHED')
    expect(body.fileId).toBe('file-id-1')
    expect(mockPrisma.artifact.create).not.toHaveBeenCalled()
  })

  // ── E5 / AC-10: DriveForbiddenError → 403 FORBIDDEN ───────────────────────

  it('E5/AC-10: returns 403 FORBIDDEN when getFileMeta throws DriveForbiddenError', async () => {
    const { DriveForbiddenError } = await import('../../src/lib/google/errors')
    mockGetFileMeta.mockRejectedValue(new DriveForbiddenError())
    mockParseDriveUrl.mockReturnValue({ kind: 'file', id: 'file-id-1' })
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://docs.google.com/document/d/abc' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('FORBIDDEN')
    expect(body.fileId).toBe('file-id-1')
    expect(mockPrisma.artifact.create).not.toHaveBeenCalled()
  })

  // ── DriveNotFoundError → 404 NOT_FOUND ─────────────────────────────────────

  it('returns 404 NOT_FOUND when getFileMeta throws DriveNotFoundError', async () => {
    const { DriveNotFoundError } = await import('../../src/lib/google/errors')
    mockGetFileMeta.mockRejectedValue(new DriveNotFoundError())
    mockParseDriveUrl.mockReturnValue({ kind: 'file', id: 'file-id-1' })
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://docs.google.com/document/d/abc' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('NOT_FOUND')
    expect(body.fileId).toBe('file-id-1')
    expect(mockPrisma.artifact.create).not.toHaveBeenCalled()
  })

  // ── AC-4 prep: Doc happy path ───────────────────────────────────────────────

  it('AC-4: 201 with GOOGLE_DOC artifact for document URL; row created with correct storageKey and parentArtifactId', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://docs.google.com/document/d/file-id-1' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.artifact).toMatchObject({ id: 'art-1', source: 'GOOGLE_DOC', sizeBytes: 0 })
    // DB create must be called with correct storageKey and null parentArtifactId
    expect(mockPrisma.artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storageKey: 'gdrive://file-id-1', parentArtifactId: null }),
      })
    )
  })

  // ── Sheet happy path ────────────────────────────────────────────────────────

  it('201 with GOOGLE_SHEET for spreadsheet URL', async () => {
    mockParseDriveUrl.mockReturnValue({ kind: 'file', id: 'sheet-1' })
    mockGetFileMeta.mockResolvedValue({
      id: 'sheet-1',
      name: 'My Sheet',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })
    mockPrisma.artifact.create.mockResolvedValue(makeArtifact({
      id: 'art-sheet',
      source: 'GOOGLE_SHEET',
      storageKey: 'gdrive://sheet-1',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    }))
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://docs.google.com/spreadsheets/d/sheet-1' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.artifact.source).toBe('GOOGLE_SHEET')
    expect(mockPrisma.artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ storageKey: 'gdrive://sheet-1' }) })
    )
  })

  // ── Slide happy path ────────────────────────────────────────────────────────

  it('201 with GOOGLE_SLIDE for presentation URL', async () => {
    mockGetFileMeta.mockResolvedValue({
      id: 'slide-1',
      name: 'My Slide',
      mimeType: 'application/vnd.google-apps.presentation',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })
    mockPrisma.artifact.create.mockResolvedValue(makeArtifact({
      id: 'art-slide',
      source: 'GOOGLE_SLIDE',
      storageKey: 'gdrive://slide-1',
      mimeType: 'application/vnd.google-apps.presentation',
    }))
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://docs.google.com/presentation/d/slide-1' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.artifact.source).toBe('GOOGLE_SLIDE')
  })

  // ── UNSUPPORTED_TYPE: unsupported mime ──────────────────────────────────────

  it('returns 409 UNSUPPORTED_TYPE for unsupported file mime (e.g. Google Form)', async () => {
    mockGetFileMeta.mockResolvedValue({
      id: 'form-1',
      name: 'My Form',
      mimeType: 'application/vnd.google-apps.form',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://docs.google.com/document/d/form-1' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('UNSUPPORTED_TYPE')
    expect(mockPrisma.artifact.create).not.toHaveBeenCalled()
  })

  // ── AC-7: folder happy path ─────────────────────────────────────────────────

  it('AC-7: 201 with folder artifact and expandedArtifacts for folder URL', async () => {
    mockParseDriveUrl.mockReturnValue({ kind: 'folder', id: 'folder-id-1' })
    mockGetFileMeta.mockResolvedValue({
      id: 'folder-id-1',
      name: 'My Folder',
      mimeType: 'application/vnd.google-apps.folder',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })
    const filesMeta = [
      { id: 'f1', name: 'Doc1', mimeType: 'application/vnd.google-apps.document', modifiedTime: '', sizeBytes: null, trashed: false },
      { id: 'f2', name: 'Sheet1', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '', sizeBytes: null, trashed: false },
      { id: 'f3', name: 'Slide1', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '', sizeBytes: null, trashed: false },
    ]
    mockListFolderRecursive.mockResolvedValue({ files: filesMeta, rejected: [] })

    const folderRow = makeArtifact({ id: 'folder-art', source: 'GOOGLE_FOLDER', storageKey: 'gdrive://folder/folder-id-1', mimeType: 'application/vnd.google-apps.folder', parentArtifactId: null })
    const childRows = [
      makeArtifact({ id: 'child-1', source: 'GOOGLE_DOC', storageKey: 'gdrive://f1', parentArtifactId: 'folder-art' }),
      makeArtifact({ id: 'child-2', source: 'GOOGLE_SHEET', storageKey: 'gdrive://f2', parentArtifactId: 'folder-art' }),
      makeArtifact({ id: 'child-3', source: 'GOOGLE_SLIDE', storageKey: 'gdrive://f3', parentArtifactId: 'folder-art' }),
    ]
    setupTransaction(folderRow, childRows)

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://drive.google.com/drive/folders/folder-id-1' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.artifact.source).toBe('GOOGLE_FOLDER')
    expect(body.expandedArtifacts).toHaveLength(3)
    // Verify children were created with parentArtifactId pointing to the folder row
    const txFn = mockPrisma.$transaction.mock.calls[0][0] as unknown
    expect(txFn).toBeDefined()
    // Child rows returned from mock carry parentArtifactId = 'folder-art'
    expect(body.expandedArtifacts[0].id).toBe('child-1')
    expect(body.expandedArtifacts[1].id).toBe('child-2')
    expect(body.expandedArtifacts[2].id).toBe('child-3')
    expect(body.expandedArtifacts[0].parentArtifactId).toBe('folder-art')
    expect(body.expandedArtifacts[1].parentArtifactId).toBe('folder-art')
    expect(body.expandedArtifacts[2].parentArtifactId).toBe('folder-art')
  })

  // ── AC-8: folder partial (rejected[]) → 422 ─────────────────────────────────

  it('AC-8: 422 PARTIAL_FOLDER with rejected entries when caps exceeded', async () => {
    mockParseDriveUrl.mockReturnValue({ kind: 'folder', id: 'folder-id-2' })
    mockGetFileMeta.mockResolvedValue({
      id: 'folder-id-2',
      name: 'Big Folder',
      mimeType: 'application/vnd.google-apps.folder',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })

    const filesMeta = Array.from({ length: 50 }, (_, i) => ({
      id: `f${i}`,
      name: `Doc${i}`,
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '',
      sizeBytes: null,
      trashed: false,
    }))
    const rejected = Array.from({ length: 10 }, (_, i) => ({ id: `rej${i}`, name: `Rej${i}`, reason: 'TOO_MANY_FILES' as const }))
    mockListFolderRecursive.mockResolvedValue({ files: filesMeta, rejected })

    const folderRow = makeArtifact({ id: 'folder-partial', source: 'GOOGLE_FOLDER', storageKey: 'gdrive://folder/folder-id-2', mimeType: 'application/vnd.google-apps.folder', parentArtifactId: null })
    const childRows = filesMeta.map((f, i) => makeArtifact({ id: `child-${i}`, source: 'GOOGLE_DOC', storageKey: `gdrive://${f.id}`, parentArtifactId: 'folder-partial' }))
    setupTransaction(folderRow, childRows)

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://drive.google.com/drive/folders/folder-id-2' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('PARTIAL_FOLDER')
    expect(body.folder.source).toBe('GOOGLE_FOLDER')
    expect(body.files).toHaveLength(50)
    expect(body.rejected).toHaveLength(10)
  })

  // ── Folder URL resolves to non-folder → 409 UNSUPPORTED_TYPE ───────────────

  it('returns 409 UNSUPPORTED_TYPE when folder URL resolves to non-folder mimeType', async () => {
    mockParseDriveUrl.mockReturnValue({ kind: 'folder', id: 'folder-id-3' })
    mockGetFileMeta.mockResolvedValue({
      id: 'folder-id-3',
      name: 'Not a Folder',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://drive.google.com/drive/folders/folder-id-3' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('UNSUPPORTED_TYPE')
    expect(mockListFolderRecursive).not.toHaveBeenCalled()
  })

  // ── E20: two users can attach same URL without deduplication ───────────────

  it('E20: two attaches of same URL produce two distinct Artifact rows', async () => {
    const row1 = makeArtifact({ id: 'art-user1' })
    const row2 = makeArtifact({ id: 'art-user2' })
    mockPrisma.artifact.create.mockResolvedValueOnce(row1).mockResolvedValueOnce(row2)

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const url = 'https://docs.google.com/document/d/file-id-1'
    const res1 = await POST(makeRequest({ url }), { params: Promise.resolve({ cardId: 'card-1' }) })
    const res2 = await POST(makeRequest({ url }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res1.status).toBe(201)
    expect(res2.status).toBe(201)
    const b1 = await res1.json()
    const b2 = await res2.json()
    expect(b1.artifact.id).toBe('art-user1')
    expect(b2.artifact.id).toBe('art-user2')
    expect(b1.artifact.storageKey).toBe(b2.artifact.storageKey)
  })

  // ── API-key auth: uploaderId resolves to first org admin ───────────────────

  it('API-key auth: uploaderId resolves to first org admin', async () => {
    mockRequireSession.mockResolvedValue({ userId: '', orgId: 'org-1', isApiKeyAuth: true })
    mockPrisma.orgMember.findFirst.mockResolvedValue({ userId: 'admin-1' })
    mockPrisma.googleCredential.findUnique.mockResolvedValue({ userId: 'admin-1' })
    const adminArtifact = makeArtifact({ uploaderId: 'admin-1', uploader: { id: 'admin-1', name: 'Admin', email: 'admin@example.com' } })
    mockPrisma.artifact.create.mockResolvedValue(adminArtifact)

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://docs.google.com/document/d/file-id-1' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(201)
    expect(mockPrisma.orgMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ role: 'ADMIN' }) })
    )
    const body = await res.json()
    expect(body.artifact.uploader.id).toBe('admin-1')
  })

  // ── aiAutoReview = true: enqueueAiReview called for file attach ─────────────

  it('aiAutoReview=true: calls enqueueAiReview once with file artifact id', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ ...baseCard, aiAutoReview: true })
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    await POST(makeRequest({ url: 'https://docs.google.com/document/d/file-id-1' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    await vi.waitFor(() => expect(mockEnqueue).toHaveBeenCalledWith('art-1'))
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  // ── aiAutoReview = true: enqueueAiReview called for each file in folder, NOT folder row ──

  it('aiAutoReview=true: calls enqueueAiReview for each file child, not the folder', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ ...baseCard, aiAutoReview: true })
    mockParseDriveUrl.mockReturnValue({ kind: 'folder', id: 'folder-id-4' })
    mockGetFileMeta.mockResolvedValue({
      id: 'folder-id-4',
      name: 'Auto Review Folder',
      mimeType: 'application/vnd.google-apps.folder',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })
    const filesMeta = [
      { id: 'fa1', name: 'A', mimeType: 'application/vnd.google-apps.document', modifiedTime: '', sizeBytes: null, trashed: false },
      { id: 'fa2', name: 'B', mimeType: 'application/vnd.google-apps.document', modifiedTime: '', sizeBytes: null, trashed: false },
      { id: 'fa3', name: 'C', mimeType: 'application/vnd.google-apps.document', modifiedTime: '', sizeBytes: null, trashed: false },
    ]
    mockListFolderRecursive.mockResolvedValue({ files: filesMeta, rejected: [] })

    const folderRow = makeArtifact({ id: 'folder-ar', source: 'GOOGLE_FOLDER', storageKey: 'gdrive://folder/folder-id-4', mimeType: 'application/vnd.google-apps.folder', parentArtifactId: null })
    const childRows = [
      makeArtifact({ id: 'ca1', source: 'GOOGLE_DOC', storageKey: 'gdrive://fa1', parentArtifactId: 'folder-ar' }),
      makeArtifact({ id: 'ca2', source: 'GOOGLE_DOC', storageKey: 'gdrive://fa2', parentArtifactId: 'folder-ar' }),
      makeArtifact({ id: 'ca3', source: 'GOOGLE_DOC', storageKey: 'gdrive://fa3', parentArtifactId: 'folder-ar' }),
    ]
    setupTransaction(folderRow, childRows)

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    await POST(makeRequest({ url: 'https://drive.google.com/drive/folders/folder-id-4' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    await vi.waitFor(() => expect(mockEnqueue).toHaveBeenCalledTimes(3))
    expect(mockEnqueue).toHaveBeenCalledWith('ca1')
    expect(mockEnqueue).toHaveBeenCalledWith('ca2')
    expect(mockEnqueue).toHaveBeenCalledWith('ca3')
    expect(mockEnqueue).not.toHaveBeenCalledWith('folder-ar')
  })

  // ── aiAutoReview = false: no enqueueAiReview calls ─────────────────────────

  it('aiAutoReview=false: does not call enqueueAiReview', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    await POST(makeRequest({ url: 'https://docs.google.com/document/d/file-id-1' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    await new Promise((r) => setTimeout(r, 20))
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  // ── lastUsedAt update ───────────────────────────────────────────────────────

  it('updates GoogleCredential.lastUsedAt after successful file attach', async () => {
    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    await POST(makeRequest({ url: 'https://docs.google.com/document/d/file-id-1' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    await vi.waitFor(() => expect(mockPrisma.googleCredential.update).toHaveBeenCalled())
    expect(mockPrisma.googleCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      })
    )
  })

  // ── Atomic folder failure: rollback on child insert error ──────────────────

  it('atomic folder failure: rollback if child insert throws', async () => {
    mockParseDriveUrl.mockReturnValue({ kind: 'folder', id: 'folder-atomic' })
    mockGetFileMeta.mockResolvedValue({
      id: 'folder-atomic',
      name: 'Atomic Folder',
      mimeType: 'application/vnd.google-apps.folder',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })
    const filesMeta = [
      { id: 'fx1', name: 'X', mimeType: 'application/vnd.google-apps.document', modifiedTime: '', sizeBytes: null, trashed: false },
      { id: 'fx2', name: 'Y', mimeType: 'application/vnd.google-apps.document', modifiedTime: '', sizeBytes: null, trashed: false },
    ]
    mockListFolderRecursive.mockResolvedValue({ files: filesMeta, rejected: [] })

    const folderRow = makeArtifact({ id: 'folder-at-row', source: 'GOOGLE_FOLDER', storageKey: 'gdrive://folder/folder-atomic', mimeType: 'application/vnd.google-apps.folder', parentArtifactId: null })

    // Simulate a real transaction that throws on second child insert
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      let callCount = 0
      const fakeTx = {
        artifact: {
          create: vi.fn().mockImplementation(() => {
            if (callCount === 0) { callCount++; return Promise.resolve(folderRow) }
            throw new Error('DB constraint violation')
          }),
        },
      }
      return fn(fakeTx as unknown as typeof mockPrisma)
    })

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://drive.google.com/drive/folders/folder-atomic' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(500)
  })

  // ── Root folder 403: special case → 403 FORBIDDEN (not 201 with empty children) ──

  it('returns 403 FORBIDDEN when listFolderRecursive returns single rejected entry = root folderId', async () => {
    mockParseDriveUrl.mockReturnValue({ kind: 'folder', id: 'forbidden-folder' })
    mockGetFileMeta.mockResolvedValue({
      id: 'forbidden-folder',
      name: 'Forbidden',
      mimeType: 'application/vnd.google-apps.folder',
      modifiedTime: new Date().toISOString(),
      sizeBytes: null,
      trashed: false,
    })
    mockListFolderRecursive.mockResolvedValue({
      files: [],
      rejected: [{ id: 'forbidden-folder', reason: 'FORBIDDEN_CHILD' }],
    })

    const { POST } = await import('../../src/app/api/cards/[cardId]/artifacts/google/route')
    const res = await POST(makeRequest({ url: 'https://drive.google.com/drive/folders/forbidden-folder' }), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('FORBIDDEN')
  })
})
