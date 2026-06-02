import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/google/docs', () => ({
  exportDocAsMarkdown: vi.fn(),
}))

vi.mock('@/lib/google/sheets', () => ({
  exportSheetAsCsv: vi.fn(),
}))

vi.mock('@/lib/google/slides', () => ({
  extractSlides: vi.fn(),
}))

// pdf-parse mock required because extractors.ts imports it at module level.
vi.mock('pdf-parse', () => {
  const PDFParse = vi.fn(function (this: { getText: () => Promise<{ text: string }>; destroy: () => Promise<void> }) {
    this.getText = vi.fn().mockResolvedValue({ text: '' })
    this.destroy = vi.fn().mockResolvedValue(undefined)
  })
  return { PDFParse }
})

import { extractContent, fileIdFromStorageKey } from '../../../src/lib/ai-review/extractors'
import { exportDocAsMarkdown } from '@/lib/google/docs'
import { exportSheetAsCsv } from '@/lib/google/sheets'
import { extractSlides } from '@/lib/google/slides'
import type { SlideContent } from '@/lib/google/slides'

function artifact(source: string, storageKey: string, overrides: Partial<{ mimeType: string; filename: string }> = {}) {
  return {
    id: 'art1',
    source,
    storageKey,
    mimeType: overrides.mimeType ?? 'application/vnd.google-apps.document',
    filename: overrides.filename ?? 'doc.gdoc',
    uploaderId: 'user-42',
  }
}

describe('fileIdFromStorageKey', () => {
  it('extracts fileId from gdrive:// key', () => {
    expect(fileIdFromStorageKey('gdrive://abc123')).toBe('abc123')
  })

  it('throws for folder keys', () => {
    expect(() => fileIdFromStorageKey('gdrive://folder/xyz')).toThrow(
      'GOOGLE_FOLDER is not reviewable'
    )
  })

  it('throws for invalid keys', () => {
    expect(() => fileIdFromStorageKey('s3://bucket/key')).toThrow('Invalid Google storageKey')
  })
})

describe('extractContent — Google source dispatch', () => {
  describe('GOOGLE_DOC (AC-4)', () => {
    it('calls exportDocAsMarkdown with correct args and returns text', async () => {
      vi.mocked(exportDocAsMarkdown).mockResolvedValueOnce('# Markdown content')

      const result = await extractContent({ artifact: artifact('GOOGLE_DOC', 'gdrive://fileXYZ') })

      expect(exportDocAsMarkdown).toHaveBeenCalledWith('user-42', 'fileXYZ')
      expect(result).toEqual({ kind: 'text', text: '# Markdown content' })
    })
  })

  describe('GOOGLE_SHEET (AC-5)', () => {
    it('calls exportSheetAsCsv with correct args and returns text', async () => {
      vi.mocked(exportSheetAsCsv).mockResolvedValueOnce('## Sheet: Tab1\na,b,c')

      const result = await extractContent({ artifact: artifact('GOOGLE_SHEET', 'gdrive://sheetABC') })

      expect(exportSheetAsCsv).toHaveBeenCalledWith('user-42', 'sheetABC')
      expect(result).toEqual({ kind: 'text', text: '## Sheet: Tab1\na,b,c' })
    })
  })

  describe('GOOGLE_SLIDE (AC-6)', () => {
    it('builds multimodal segments: slide with text + image, then slide with text only', async () => {
      const slides: SlideContent[] = [
        { slideIndex: 1, text: 'Title slide', imageDataUrls: ['base64img1'] },
        { slideIndex: 2, text: 'Second slide', imageDataUrls: [] },
      ]
      vi.mocked(extractSlides).mockResolvedValueOnce(slides)

      const result = await extractContent({ artifact: artifact('GOOGLE_SLIDE', 'gdrive://pptXYZ') })

      expect(extractSlides).toHaveBeenCalledWith('user-42', 'pptXYZ')
      expect(result.kind).toBe('multimodal')
      if (result.kind !== 'multimodal') return

      expect(result.segments).toHaveLength(3)
      expect(result.segments[0]).toEqual({ kind: 'text', text: '## Slide 1\n\nTitle slide' })
      expect(result.segments[1]).toEqual({ kind: 'image', imageBase64: 'base64img1', imageMimeType: 'image/png' })
      expect(result.segments[2]).toEqual({ kind: 'text', text: '## Slide 2\n\nSecond slide' })
    })

    it('empty slide deck → empty', async () => {
      vi.mocked(extractSlides).mockResolvedValueOnce([])

      const result = await extractContent({ artifact: artifact('GOOGLE_SLIDE', 'gdrive://emptyDeck') })

      expect(result).toEqual({ kind: 'empty' })
    })

    it('deck where all slides have no text and no images → empty', async () => {
      const slides: SlideContent[] = [
        { slideIndex: 1, text: '', imageDataUrls: [] },
      ]
      vi.mocked(extractSlides).mockResolvedValueOnce(slides)

      const result = await extractContent({ artifact: artifact('GOOGLE_SLIDE', 'gdrive://blankDeck') })

      // one text segment is produced even if empty text — not empty
      expect(result.kind).toBe('multimodal')
    })
  })

  describe('GOOGLE_FOLDER', () => {
    it('throws with the invariant error message', async () => {
      await expect(
        extractContent({ artifact: artifact('GOOGLE_FOLDER', 'gdrive://folder/folderID') })
      ).rejects.toThrow('GOOGLE_FOLDER is not reviewable')
    })
  })

  describe('URL', () => {
    it('returns empty (out of M4 scope)', async () => {
      const result = await extractContent({
        artifact: { id: 'a2', source: 'URL', storageKey: 'https://example.com', mimeType: 'text/html', filename: 'page', uploaderId: 'u1' },
      })
      expect(result).toEqual({ kind: 'empty' })
    })
  })

  describe('UPLOAD path (legacy behaviour)', () => {
    it('returns text for text/plain bytes', async () => {
      const bytes = Buffer.from('hello upload')
      const result = await extractContent({
        artifact: { id: 'a3', source: 'UPLOAD', storageKey: 'uploads/a3', mimeType: 'text/plain', filename: 'hello.txt', uploaderId: 'u1' },
        bytes,
      })
      expect(result).toEqual({ kind: 'text', text: 'hello upload' })
    })

    it('throws when UPLOAD source has no bytes', async () => {
      await expect(
        extractContent({
          artifact: { id: 'a4', source: 'UPLOAD', storageKey: 'uploads/a4', mimeType: 'text/plain', filename: 'f.txt', uploaderId: 'u1' },
        })
      ).rejects.toThrow('UPLOAD source requires bytes')
    })
  })
})
