import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted. Factory cannot use external variables.
vi.mock('pdf-parse', () => {
   
  const PDFParse = vi.fn(function (this: any) {
    this.getText = vi.fn().mockResolvedValue({ text: '' })
    this.destroy = vi.fn().mockResolvedValue(undefined)
  })
  return { PDFParse }
})

import { extractContent, PDF_SIZE_CAP } from '../../src/lib/ai-review/extractors'
import { PDFParse } from 'pdf-parse'

const IMAGE_SIZE_CAP = 5 * 1024 * 1024

function uploadArtifact(buf: Buffer, mimeType: string, filename: string) {
  return { artifact: { id: 'a1', source: 'UPLOAD', storageKey: 'uploads/a1', mimeType, filename, uploaderId: 'u1' }, bytes: buf }
}

describe('extractContent', () => {
  beforeEach(() => {
    // Reset clears the once queue then restore a default implementation.
    vi.mocked(PDFParse).mockReset()

    vi.mocked(PDFParse).mockImplementation(function (this: any) {
      this.getText = vi.fn().mockResolvedValue({ text: '' })
      this.destroy = vi.fn().mockResolvedValue(undefined)
    })
  })

  describe('text MIME types', () => {
    it('text/plain → utf-8 text', async () => {
      const buf = Buffer.from('hello world', 'utf-8')
      const result = await extractContent(uploadArtifact(buf, 'text/plain', 'file.txt'))
      expect(result).toEqual({ kind: 'text', text: 'hello world' })
    })

    it('text/csv → utf-8 text', async () => {
      const buf = Buffer.from('a,b,c', 'utf-8')
      const result = await extractContent(uploadArtifact(buf, 'text/csv', 'data.csv'))
      expect(result.kind).toBe('text')
    })

    it('application/json → utf-8 text', async () => {
      const buf = Buffer.from('{"key":"val"}', 'utf-8')
      const result = await extractContent(uploadArtifact(buf, 'application/json', 'data.json'))
      expect(result.kind).toBe('text')
      if (result.kind === 'text') expect(result.text).toBe('{"key":"val"}')
    })

    it('application/x-yaml → utf-8 text', async () => {
      const buf = Buffer.from('key: value', 'utf-8')
      const result = await extractContent(uploadArtifact(buf, 'application/x-yaml', 'config.yaml'))
      expect(result.kind).toBe('text')
    })

    it('text/markdown → utf-8 text', async () => {
      const buf = Buffer.from('# Heading', 'utf-8')
      const result = await extractContent(uploadArtifact(buf, 'text/markdown', 'README.md'))
      expect(result.kind).toBe('text')
    })
  })

  describe('PDF extraction', () => {
    it('PDF with extracted text → text (E12 happy path)', async () => {
      const getText = vi.fn().mockResolvedValue({ text: 'PDF content here' })
      const destroy = vi.fn().mockResolvedValue(undefined)

      vi.mocked(PDFParse).mockImplementationOnce(function (this: any) {
        this.getText = getText
        this.destroy = destroy
      })

      const buf = Buffer.from('%PDF-fake')
      const result = await extractContent(uploadArtifact(buf, 'application/pdf', 'doc.pdf'))
      expect(result).toEqual({ kind: 'text', text: 'PDF content here' })
    })

    it('PDF with empty text → empty (E12)', async () => {
      const getText = vi.fn().mockResolvedValue({ text: '   ' })
      const destroy = vi.fn().mockResolvedValue(undefined)

      vi.mocked(PDFParse).mockImplementationOnce(function (this: any) {
        this.getText = getText
        this.destroy = destroy
      })

      const buf = Buffer.from('%PDF-fake')
      const result = await extractContent(uploadArtifact(buf, 'application/pdf', 'empty.pdf'))
      expect(result).toEqual({ kind: 'empty' })
    })

    it('PDF extraction throws → empty', async () => {
      const getText = vi.fn().mockRejectedValue(new Error('encrypted PDF'))
      const destroy = vi.fn().mockResolvedValue(undefined)

      vi.mocked(PDFParse).mockImplementationOnce(function (this: any) {
        this.getText = getText
        this.destroy = destroy
      })

      const buf = Buffer.from('%PDF-fake')
      const result = await extractContent(uploadArtifact(buf, 'application/pdf', 'locked.pdf'))
      expect(result).toEqual({ kind: 'empty' })
    })

    it('PDF over 10 MB → empty (PDF size cap)', async () => {
      const buf = Buffer.alloc(PDF_SIZE_CAP + 1)
      const result = await extractContent(uploadArtifact(buf, 'application/pdf', 'huge.pdf'))
      expect(result).toEqual({ kind: 'empty' })
      // PDFParse should not be called when over cap
      expect(vi.mocked(PDFParse)).not.toHaveBeenCalled()
    })

    it('PDF exactly at 10 MB → parsed normally (boundary)', async () => {
      const getText = vi.fn().mockResolvedValue({ text: 'boundary content' })
      const destroy = vi.fn().mockResolvedValue(undefined)

      vi.mocked(PDFParse).mockImplementationOnce(function (this: any) {
        this.getText = getText
        this.destroy = destroy
      })

      const buf = Buffer.alloc(PDF_SIZE_CAP)
      const result = await extractContent(uploadArtifact(buf, 'application/pdf', 'boundary.pdf'))
      expect(result).toEqual({ kind: 'text', text: 'boundary content' })
    })
  })

  describe('image types', () => {
    it('image/png ≤5 MB → base64 image', async () => {
      const buf = Buffer.alloc(100, 0xff)
      const result = await extractContent(uploadArtifact(buf, 'image/png', 'img.png'))
      expect(result.kind).toBe('image')
      if (result.kind === 'image') {
        expect(result.imageBase64).toBe(buf.toString('base64'))
        expect(result.imageMimeType).toBe('image/png')
      }
    })

    it('image/jpeg ≤5 MB → base64 image', async () => {
      const buf = Buffer.alloc(50)
      const result = await extractContent(uploadArtifact(buf, 'image/jpeg', 'photo.jpg'))
      expect(result.kind).toBe('image')
      if (result.kind === 'image') expect(result.imageMimeType).toBe('image/jpeg')
    })

    it('image/webp ≤5 MB → base64 image', async () => {
      const buf = Buffer.alloc(50)
      const result = await extractContent(uploadArtifact(buf, 'image/webp', 'img.webp'))
      expect(result.kind).toBe('image')
    })

    it('image/png >5 MB → empty (E10 image size cap)', async () => {
      const buf = Buffer.alloc(IMAGE_SIZE_CAP + 1)
      const result = await extractContent(uploadArtifact(buf, 'image/png', 'huge.png'))
      expect(result).toEqual({ kind: 'empty' })
    })

    it('image exactly at 5 MB → image (boundary)', async () => {
      const buf = Buffer.alloc(IMAGE_SIZE_CAP)
      const result = await extractContent(uploadArtifact(buf, 'image/png', 'exact.png'))
      expect(result.kind).toBe('image')
    })
  })

  describe('unsupported / defensive', () => {
    it('unknown MIME → empty', async () => {
      const buf = Buffer.from('binary')
      const result = await extractContent(uploadArtifact(buf, 'application/octet-stream', 'file.bin'))
      expect(result).toEqual({ kind: 'empty' })
    })
  })
})
