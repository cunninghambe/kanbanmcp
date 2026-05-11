import { PDFParse } from 'pdf-parse'

const IMAGE_SIZE_CAP = 5 * 1024 * 1024 // 5 MB

export interface ExtractedContent {
  kind: 'text' | 'image' | 'empty'
  text?: string
  imageBase64?: string
  imageMimeType?: string
}

const TEXT_MIMES = new Set([
  'application/json',
  'application/x-yaml',
  'text/markdown',
])

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || TEXT_MIMES.has(mimeType)
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes), verbosity: 0 })
  const result = await parser.getText()
  await parser.destroy()
  return result.text
}

export async function extractContent(
  bytes: Buffer,
  mimeType: string,
  _filename: string
): Promise<ExtractedContent> {
  if (isTextMime(mimeType)) {
    return { kind: 'text', text: bytes.toString('utf-8') }
  }

  if (mimeType === 'application/pdf') {
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
    return {
      kind: 'image',
      imageBase64: bytes.toString('base64'),
      imageMimeType: mimeType,
    }
  }

  // Defensive — upload allowlist should prevent reaching here.
  return { kind: 'empty' }
}
