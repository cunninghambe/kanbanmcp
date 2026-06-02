import { PDFParse } from 'pdf-parse'
import { exportDocAsMarkdown } from '@/lib/google/docs'
import { exportSheetAsCsv } from '@/lib/google/sheets'
import { extractSlides } from '@/lib/google/slides'
import type { SlideContent } from '@/lib/google/slides'

const IMAGE_SIZE_CAP = 5 * 1024 * 1024 // 5 MB
export const PDF_SIZE_CAP = 10 * 1024 * 1024 // 10 MB

export type ExtractedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; imageBase64: string; imageMimeType: 'image/png' | 'image/jpeg' | 'image/webp' }

export type ExtractedContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; imageBase64: string; imageMimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { kind: 'multimodal'; segments: ExtractedSegment[] }
  | { kind: 'empty' }

export interface ExtractContentInput {
  artifact: {
    id: string
    source: string
    storageKey: string
    mimeType: string
    filename: string
    uploaderId: string
  }
  bytes?: Buffer
}

export function fileIdFromStorageKey(storageKey: string): string {
  if (storageKey.startsWith('gdrive://folder/')) {
    throw new Error(`GOOGLE_FOLDER is not reviewable — folders expand to file artifacts at attach time`)
  }
  if (storageKey.startsWith('gdrive://')) {
    return storageKey.slice('gdrive://'.length)
  }
  throw new Error(`Invalid Google storageKey: ${storageKey}`)
}

const TEXT_MIMES = new Set(['application/json', 'application/x-yaml', 'text/markdown'])

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || TEXT_MIMES.has(mimeType)
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes), verbosity: 0 })
  const result = await parser.getText()
  await parser.destroy()
  return result.text
}

function buildSlidesSegments(slides: SlideContent[]): ExtractedSegment[] {
  const segments: ExtractedSegment[] = []
  for (const slide of slides) {
    segments.push({ kind: 'text', text: `## Slide ${slide.slideIndex}\n\n${slide.text}` })
    for (const dataUrl of slide.imageDataUrls) {
      segments.push({ kind: 'image', imageBase64: dataUrl, imageMimeType: 'image/png' })
    }
  }
  return segments
}

async function extractUpload(bytes: Buffer, mimeType: string): Promise<ExtractedContent> {
  if (isTextMime(mimeType)) {
    return { kind: 'text', text: bytes.toString('utf-8') }
  }

  if (mimeType === 'application/pdf') {
    if (bytes.length > PDF_SIZE_CAP) return { kind: 'empty' }
    try {
      const text = await extractPdfText(bytes)
      if (text.trim().length > 0) return { kind: 'text', text }
    } catch {
      // fall through to empty
    }
    return { kind: 'empty' }
  }

  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp') {
    if (bytes.length > IMAGE_SIZE_CAP) return { kind: 'empty' }
    return { kind: 'image', imageBase64: bytes.toString('base64'), imageMimeType: mimeType }
  }

  return { kind: 'empty' }
}

export async function extractContent(input: ExtractContentInput): Promise<ExtractedContent> {
  const { artifact, bytes } = input

  switch (artifact.source) {
    case 'GOOGLE_DOC': {
      const fileId = fileIdFromStorageKey(artifact.storageKey)
      const text = await exportDocAsMarkdown(artifact.uploaderId, fileId)
      return { kind: 'text', text }
    }
    case 'GOOGLE_SHEET': {
      const fileId = fileIdFromStorageKey(artifact.storageKey)
      const text = await exportSheetAsCsv(artifact.uploaderId, fileId)
      return { kind: 'text', text }
    }
    case 'GOOGLE_SLIDE': {
      const fileId = fileIdFromStorageKey(artifact.storageKey)
      const slides = await extractSlides(artifact.uploaderId, fileId)
      const segments = buildSlidesSegments(slides)
      if (segments.length === 0) return { kind: 'empty' }
      return { kind: 'multimodal', segments }
    }
    case 'GOOGLE_FOLDER':
      throw new Error('GOOGLE_FOLDER is not reviewable — folders expand to file artifacts at attach time')
    case 'URL':
      return { kind: 'empty' }
    default: {
      // UPLOAD or unknown — MIME-based extraction
      if (!bytes) throw new Error('UPLOAD source requires bytes')
      return extractUpload(bytes, artifact.mimeType)
    }
  }
}
