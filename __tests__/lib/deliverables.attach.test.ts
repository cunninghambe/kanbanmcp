/**
 * Unit tests for attachDeliverableArtifact (M3 Task 3 — TDD)
 * Module under test does not exist yet — correct failing TDD state.
 * Spec: AC1, AC3, AC4 / E2 (missing), E7 (oversized), MIME-rejected, rollback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const mockArtifact = { create: vi.fn(), update: vi.fn(), delete: vi.fn() }
vi.mock('@/lib/db', () => ({ prisma: { artifact: mockArtifact } }))

const mockStoragePut = vi.fn()
vi.mock('@/lib/storage', () => ({
  getStorageDriver: () => ({ put: mockStoragePut, getStream: vi.fn(), delete: vi.fn() }),
}))

import { attachDeliverableArtifact } from '../../src/lib/card-execution/deliverables'
import { MAX_ARTIFACT_BYTES } from '../../src/lib/artifacts'

const CARD_ID = 'card-001'
const ART_ID = 'art-001'

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kanban-attach-'))
  await fsp.mkdir(path.join(tmpDir, 'deliverables'), { recursive: true })
  const row = (k: string) => ({ id: ART_ID, cardId: CARD_ID, storageKey: k, source: 'UPLOAD' })
  mockArtifact.create.mockResolvedValue(row('pending'))
  mockArtifact.update.mockResolvedValue(row(ART_ID))
  mockStoragePut.mockResolvedValue({ key: ART_ID })
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

async function writeDeliverable(name: string, content: string | Buffer): Promise<void> {
  await fsp.writeFile(path.join(tmpDir, 'deliverables', name), content)
}

describe('attachDeliverableArtifact — happy paths', () => {
  it('markdown deliverable — returns { artifactId, filename } and creates DB row with correct fields', async () => {
    // Given
    await writeDeliverable('plan.md', '# Plan\nsome content')

    // When
    const result = await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/plan.md')

    // Then — return shape
    expect(result).toEqual({ artifactId: ART_ID, filename: 'plan.md' })

    // DB row created with agent uploader, correct MIME, cardId, source
    expect(mockArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cardId: CARD_ID,
          uploaderId: 'agent-claude-code',
          filename: 'plan.md',
          mimeType: 'text/markdown',
          source: 'UPLOAD',
          storageKey: 'pending',
        }),
      })
    )

    // Storage called with artifact id as key
    expect(mockStoragePut).toHaveBeenCalledWith(ART_ID, expect.any(Buffer), 'text/markdown')

    // storageKey updated to artifact id
    expect(mockArtifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ART_ID },
        data: { storageKey: ART_ID },
      })
    )
  })

  it('XLSX deliverable — MIME is application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', async () => {
    // Given
    await writeDeliverable('model.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04]))

    // When
    await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/model.xlsx')

    // Then
    expect(mockArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      })
    )
  })

  it('PPTX deliverable — MIME is application/vnd.openxmlformats-officedocument.presentationml.presentation', async () => {
    // Given
    await writeDeliverable('deck.pptx', Buffer.from([0x50, 0x4b, 0x03, 0x04]))

    // When
    await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/deck.pptx')

    // Then
    expect(mockArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      })
    )
  })

  it('DOCX deliverable — MIME is application/vnd.openxmlformats-officedocument.wordprocessingml.document', async () => {
    // Given
    await writeDeliverable('report.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04]))

    // When
    await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/report.docx')

    // Then
    expect(mockArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      })
    )
  })

  it('HTML deliverable — MIME is text/html', async () => {
    // Given
    await writeDeliverable('landing.html', '<html><body>Hello</body></html>')

    // When
    await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/landing.html')

    // Then
    expect(mockArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mimeType: 'text/html' }),
      })
    )
  })

  it('CSV deliverable — MIME is text/csv', async () => {
    // Given
    await writeDeliverable('data.csv', 'col1,col2\nval1,val2\n')

    // When
    await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/data.csv')

    // Then
    expect(mockArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mimeType: 'text/csv' }),
      })
    )
  })

  it('JSON deliverable — MIME is application/json', async () => {
    // Given
    await writeDeliverable('output.json', '{"key":"value"}')

    // When
    await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/output.json')

    // Then
    expect(mockArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mimeType: 'application/json' }),
      })
    )
  })

  it('sizeBytes on the artifact row matches actual byte length of the file on disk', async () => {
    // Given
    const content = 'Exactly this many bytes matters.'
    await writeDeliverable('sized.md', content)
    const expectedSize = Buffer.byteLength(content)

    // When
    await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/sized.md')

    // Then
    expect(mockArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sizeBytes: expectedSize }),
      })
    )
  })
})

describe('attachDeliverableArtifact — skip paths', () => {
  it('missing file (ENOENT) — returns { skipped: "missing" }, no DB row created (E2)', async () => {
    // Given — nothing written to tmpdir/deliverables/nonexistent.md

    // When
    const result = await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/nonexistent.md')

    // Then
    expect(result).toEqual({ skipped: 'missing' })
    expect(mockArtifact.create).not.toHaveBeenCalled()
    expect(mockStoragePut).not.toHaveBeenCalled()
  })

  it('empty file (0 bytes) — returns { skipped: "empty" }, no DB row created', async () => {
    // Given
    await writeDeliverable('empty.md', '')

    // When
    const result = await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/empty.md')

    // Then
    expect(result).toEqual({ skipped: 'empty' })
    expect(mockArtifact.create).not.toHaveBeenCalled()
    expect(mockStoragePut).not.toHaveBeenCalled()
  })

  it('oversized file (size > MAX_ARTIFACT_BYTES) — returns { skipped: "too_large" } (E7)', async () => {
    // Given — stub stat so the test stays fast (no 25MB allocation)
    await writeDeliverable('big.md', 'placeholder')
    const fspMod = await import('node:fs/promises')
    const statSpy = vi.spyOn(fspMod, 'stat').mockResolvedValueOnce({
      size: MAX_ARTIFACT_BYTES + 1,
      isFile: () => true,
    } as unknown as import('node:fs').Stats)

    // When
    const result = await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/big.md')

    // Then
    expect(result).toEqual({ skipped: 'too_large' })
    expect(mockArtifact.create).not.toHaveBeenCalled()
    expect(mockStoragePut).not.toHaveBeenCalled()

    statSpy.mockRestore()
  })

  it('unknown extension (.exe) — returns { skipped: "mime_rejected" }, no DB row created', async () => {
    // Given
    await writeDeliverable('malware.exe', Buffer.from([0x4d, 0x5a]))

    // When
    const result = await attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/malware.exe')

    // Then
    expect(result).toEqual({ skipped: 'mime_rejected' })
    expect(mockArtifact.create).not.toHaveBeenCalled()
    expect(mockStoragePut).not.toHaveBeenCalled()
  })
})

describe('attachDeliverableArtifact — storage error rollback', () => {
  it('when storage.put throws, the artifact DB row is deleted and the error is rethrown', async () => {
    // Given
    await writeDeliverable('plan.md', '# Plan')
    const storageError = new Error('disk full')
    mockStoragePut.mockRejectedValue(storageError)
    mockArtifact.delete.mockResolvedValue({})

    // When / Then — rethrows (same semantics as M1 route returning 500 after rollback)
    await expect(
      attachDeliverableArtifact(CARD_ID, tmpDir, '/deliverables/plan.md')
    ).rejects.toThrow('disk full')

    // DB row was created
    expect(mockArtifact.create).toHaveBeenCalledOnce()

    // Rollback: row deleted by id
    expect(mockArtifact.delete).toHaveBeenCalledWith({ where: { id: ART_ID } })

    // storageKey update was NOT called
    expect(mockArtifact.update).not.toHaveBeenCalled()
  })
})
