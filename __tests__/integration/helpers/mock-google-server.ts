/**
 * In-process mock Google server for M4 integration tests.
 *
 * Installs a __setGoogleFetchForTests stub that routes by URL prefix.
 * Throws "Unmatched URL: <url>" for any URL not covered by the dispatch table,
 * which surfaces wiring bugs immediately.
 */

import { __setGoogleFetchForTests } from '../../../src/lib/google/fetch'
import type { GoogleFetch } from '../../../src/lib/google/fetch'

export interface MockFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  size?: string
  trashed?: boolean
  children?: string[]
  docMarkdown?: string
  sheetTabs?: Array<{ title: string; rows: string[][] }>
  slides?: Array<{ text: string; imageBytesB64: string[] }>
}

export interface MockState {
  files: Record<string, MockFile>
  tokenExchangeResponse?: {
    accessToken: string
    refreshToken: string
    expiresInSec: number
    scope: string
  }
  userinfoResponse?: { email: string; sub: string }
  /**
   * Today planner (WI-2): raw Google Calendar event resources returned by
   * GET /calendar/v3/calendars/primary/events. `status` overrides the HTTP
   * status (e.g. 403 to simulate a missing scope).
   */
  calendar?: { events: unknown[]; status?: number }
  /**
   * Today planner (WI-2): every multipart upload to /upload/drive/v3/files is
   * recorded here (url + raw init) and answered with `uploadResponse` (default
   * `{ id: 'newdoc1', name: <metadata.name>, webViewLink }`). `uploadStatus`
   * overrides the HTTP status.
   */
  uploads?: Array<{
    url: string
    init: FetchInit | undefined
    metadata: Record<string, unknown> | null
    media: string | null
  }>
  uploadResponse?: { id: string; name?: string; webViewLink?: string }
  uploadStatus?: number
}

type FetchInit = Parameters<GoogleFetch>[1]

type FakeResponse = Awaited<ReturnType<GoogleFetch>>

function makeJson(data: unknown, status = 200): FakeResponse {
  const text = JSON.stringify(data)
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => data,
  }
}

function makeText(body: string, status = 200): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => { throw new Error('Not JSON') },
  }
}

function makeBytes(b64: string, status = 200): FakeResponse {
  const buf = Buffer.from(b64, 'base64')
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => buf.toString('utf-8'),
    json: async () => { throw new Error('Not JSON') },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }
}

function driveFileMeta(f: MockFile) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime ?? '2024-01-01T00:00:00Z',
    size: f.size,
    trashed: f.trashed ?? false,
  }
}

/** Splits a multipart/related body into its JSON metadata part and its media part. */
function parseMultipart(init: FetchInit | undefined): {
  metadata: Record<string, unknown> | null
  media: string | null
} {
  const contentType = init?.headers?.['Content-Type'] ?? init?.headers?.['content-type'] ?? ''
  const boundaryMatch = contentType.match(/boundary=([^;]+)/)
  const body = typeof init?.body === 'string' ? init.body : ''
  if (!boundaryMatch || !body) return { metadata: null, media: null }
  const boundary = boundaryMatch[1].replace(/^"|"$/g, '')
  const parts = body
    .split(`--${boundary}`)
    .map((p) => p.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
    .filter((p) => p && p !== '--' && p !== '--\r\n')
  let metadata: Record<string, unknown> | null = null
  let media: string | null = null
  for (const part of parts) {
    const sep = part.indexOf('\r\n\r\n')
    if (sep === -1) continue
    const headers = part.slice(0, sep).toLowerCase()
    const content = part.slice(sep + 4)
    if (headers.includes('application/json')) {
      try {
        metadata = JSON.parse(content) as Record<string, unknown>
      } catch {
        metadata = null
      }
    } else {
      media = content
    }
  }
  return { metadata, media }
}

function dispatch(url: string, init: FetchInit | undefined, state: MockState): FakeResponse {
  // Today planner: Calendar events list
  if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
    const status = state.calendar?.status ?? 200
    if (status !== 200) {
      return makeJson(
        { error: { code: status, message: status === 403 ? 'Insufficient Permission' : 'error' } },
        status
      )
    }
    return makeJson({ kind: 'calendar#events', items: state.calendar?.events ?? [] })
  }

  // Today planner: Drive multipart upload (Google Doc created from Markdown)
  if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
    const { metadata, media } = parseMultipart(init)
    ;(state.uploads ??= []).push({ url, init, metadata, media })
    const status = state.uploadStatus ?? 200
    if (status !== 200) {
      return makeJson(
        { error: { code: status, message: status === 403 ? 'Insufficient Permission' : 'error' } },
        status
      )
    }
    const id = state.uploadResponse?.id ?? 'newdoc1'
    const name =
      state.uploadResponse?.name ??
      (typeof metadata?.name === 'string' ? metadata.name : 'Untitled')
    const webViewLink =
      state.uploadResponse?.webViewLink ??
      `https://docs.google.com/document/d/${id}/edit?usp=drivesdk`
    return makeJson({ id, name, webViewLink })
  }

  // Token exchange
  if (url === 'https://oauth2.googleapis.com/token') {
    const tr = state.tokenExchangeResponse
    if (!tr) return makeJson({ error: 'no_token_configured' }, 400)
    return makeJson({
      access_token: tr.accessToken,
      refresh_token: tr.refreshToken,
      expires_in: tr.expiresInSec,
      scope: tr.scope,
      token_type: 'Bearer',
    })
  }

  // Revoke — always succeed
  if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
    return makeJson({})
  }

  // Userinfo
  if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
    const ui = state.userinfoResponse
    if (!ui) return makeJson({ error: 'no_userinfo' }, 400)
    return makeJson(ui)
  }

  // Drive file metadata: /drive/v3/files/{id}?fields=...  (no /export suffix)
  const fileMetaMatch = url.match(
    /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?#]+)\?/
  )
  if (fileMetaMatch && !url.includes('/export')) {
    const fileId = fileMetaMatch[1]
    const file = state.files[fileId]
    if (!file) return makeJson({ error: 'notFound', message: 'File not found.' }, 404)
    return makeJson(driveFileMeta(file))
  }

  // Drive export: /drive/v3/files/{id}/export
  const exportMatch = url.match(
    /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?#]+)\/export/
  )
  if (exportMatch) {
    const fileId = exportMatch[1]
    const file = state.files[fileId]
    if (!file) return makeJson({ error: 'notFound' }, 404)
    return makeText(file.docMarkdown ?? '')
  }

  // Drive list (folder children): /drive/v3/files?q='...' in parents
  if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
    const qParam = decodeURIComponent(new URL(url).searchParams.get('q') ?? '')
    const parentMatch = qParam.match(/'([^']+)' in parents/)
    if (!parentMatch) throw new Error(`Unmatched Drive list URL: ${url}`)
    const parentId = parentMatch[1]
    const folder = state.files[parentId]
    const childIds = folder?.children ?? []
    const files = childIds
      .map((id) => state.files[id])
      .filter((f): f is MockFile => f !== undefined)
      .map(driveFileMeta)
    return makeJson({ files })
  }

  // Sheets metadata: /v4/spreadsheets/{id}?fields=...
  const sheetsMetaMatch = url.match(
    /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/([^/?#]+)\?/
  )
  if (sheetsMetaMatch) {
    const fileId = sheetsMetaMatch[1]
    const file = state.files[fileId]
    if (!file) return makeJson({ error: 'notFound' }, 404)
    const sheets = (file.sheetTabs ?? []).map((tab) => ({
      properties: { title: tab.title, gridProperties: { rowCount: tab.rows.length, columnCount: tab.rows[0]?.length ?? 0 } },
    }))
    return makeJson({ sheets })
  }

  // Sheets values: /v4/spreadsheets/{id}/values/{tab}
  const sheetsValuesMatch = url.match(
    /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/([^/?#]+)\/values\/([^?#]+)/
  )
  if (sheetsValuesMatch) {
    const fileId = sheetsValuesMatch[1]
    const tabEncoded = sheetsValuesMatch[2]
    const tabTitle = decodeURIComponent(tabEncoded)
    const file = state.files[fileId]
    if (!file) return makeJson({ error: 'notFound' }, 404)
    const tab = (file.sheetTabs ?? []).find((t) => t.title === tabTitle)
    return makeJson({ values: tab?.rows ?? [] })
  }

  // Slides presentation: /v1/presentations/{id}
  const slidesMatch = url.match(
    /^https:\/\/slides\.googleapis\.com\/v1\/presentations\/([^/?#]+)$/
  )
  if (slidesMatch) {
    const fileId = slidesMatch[1]
    const file = state.files[fileId]
    if (!file) return makeJson({ error: 'notFound' }, 404)
    const slides = (file.slides ?? []).map((s, i) => ({
      objectId: `slide_${i}`,
      pageElements: [
        {
          shape: {
            text: {
              textElements: s.text ? [{ textRun: { content: s.text } }] : [],
            },
          },
        },
        ...s.imageBytesB64.map((b64, j) => ({
          image: { contentUrl: `https://mock-slide-image/${fileId}/${i}/${j}` },
        })),
      ],
    }))
    return makeJson({ slides })
  }

  // Slide image content URLs
  if (url.startsWith('https://mock-slide-image/')) {
    const parts = url.split('/')
    const fileId = parts[3]
    const slideIdx = parseInt(parts[4], 10)
    const imgIdx = parseInt(parts[5], 10)
    const file = state.files[fileId]
    const b64 = file?.slides?.[slideIdx]?.imageBytesB64[imgIdx]
    if (!b64) return makeJson({ error: 'notFound' }, 404)
    return makeBytes(b64)
  }

  throw new Error(`Unmatched Google URL: ${url}`)
}

export function installMockGoogleServer(state: MockState): { reset(): void } {
  const handler: GoogleFetch = (url, init) => Promise.resolve(dispatch(url, init, state))
  __setGoogleFetchForTests(handler)
  return {
    reset() {
      __setGoogleFetchForTests(null)
    },
  }
}
