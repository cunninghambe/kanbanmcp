import { googleFetch } from './fetch'
import { ensureFreshAccessToken } from './oauth'
import { DriveForbiddenError, DriveNotFoundError, GoogleHttpError } from './errors'

export const SLIDES_IMAGES_PER_SLIDE_CAP = 5

export interface SlideContent {
  slideIndex: number
  text: string
  imageDataUrls: string[]
}

// ─── Internal Slides API types ────────────────────────────────────────────────

type TextRun = { content: string }
type TextElement = { textRun?: TextRun }
type Shape = { text?: { textElements: TextElement[] } }
type Image = { contentUrl: string }
type PageElement = { shape?: Shape; image?: Image }
type Slide = { objectId: string; pageElements?: PageElement[] }
type PresentationResponse = { slides?: Slide[] }

// ─── Text extraction ──────────────────────────────────────────────────────────

function extractSlideText(elements: PageElement[]): string {
  const parts: string[] = []
  for (const el of elements) {
    if (!el.shape?.text?.textElements) continue
    for (const te of el.shape.text.textElements) {
      if (te.textRun?.content) parts.push(te.textRun.content)
    }
  }
  return parts.join('\n').trimEnd()
}

// ─── Image fetching ───────────────────────────────────────────────────────────

async function fetchImageBase64(contentUrl: string, token: string, userId: string): Promise<string | null> {
  const res = await googleFetch(contentUrl, { headers: { Authorization: `Bearer ${token}` } }, { userId, retry: true })
  if (!res.ok || !res.arrayBuffer) return null
  const buf = await res.arrayBuffer()
  return Buffer.from(buf).toString('base64')
}

async function fetchSlideImages(
  imageUrls: string[],
  token: string,
  userId: string,
): Promise<{ dataUrls: string[]; skipped: number }> {
  const capped = imageUrls.slice(0, SLIDES_IMAGES_PER_SLIDE_CAP)
  const skipped = imageUrls.length - capped.length
  const results = await Promise.all(capped.map((url) => fetchImageBase64(url, token, userId)))
  const dataUrls = results.filter((r): r is string => r !== null)
  return { dataUrls, skipped }
}

// ─── Public export ────────────────────────────────────────────────────────────

export async function extractSlides(userId: string, fileId: string): Promise<SlideContent[]> {
  const token = await ensureFreshAccessToken(userId)
  const url = `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(fileId)}`
  const res = await googleFetch(url, { headers: { Authorization: `Bearer ${token}` } }, { userId, retry: true })

  if (res.status === 404) throw new DriveNotFoundError()
  if (res.status === 403) throw new DriveForbiddenError()
  if (!res.ok) throw new GoogleHttpError(res.status, await res.text())

  const presentation = (await res.json()) as PresentationResponse
  const slides = presentation.slides ?? []
  const output: SlideContent[] = []

  for (let i = 0; i < slides.length; i++) {
    const elements = slides[i].pageElements ?? []
    const imageUrls = elements.filter((el) => el.image?.contentUrl).map((el) => el.image!.contentUrl)
    const text = extractSlideText(elements)
    const { dataUrls, skipped } = await fetchSlideImages(imageUrls, token, userId)

    const finalText = skipped > 0 ? `${text}\n[${skipped} additional images not included]`.trimStart() : text

    output.push({ slideIndex: i + 1, text: finalText, imageDataUrls: dataUrls })
  }

  return output
}
