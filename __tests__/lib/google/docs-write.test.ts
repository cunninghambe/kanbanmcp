/**
 * Google Doc creation from Markdown via a Drive multipart upload (spec §4.6
 * docs-write.ts). Transport must NOT retry (non-idempotent create). (WI-2)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  assertScopes: vi.fn(),
}))
vi.mock('../../../src/lib/google/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/google/oauth')>()
  return {
    ...actual,
    ensureFreshAccessToken: (...a: unknown[]) => mocks.ensureFreshAccessToken(...a),
  }
})
vi.mock('../../../src/lib/google/scopes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/google/scopes')>()
  return { ...actual, assertScopes: (...a: unknown[]) => mocks.assertScopes(...a) }
})

import { createDocFromMarkdown } from '../../../src/lib/google/docs-write'
import { DRIVE_FILE_SCOPE } from '../../../src/lib/google/scopes'
import { __setFetchSleeperForTests, __setRawFetchForTests } from '../../../src/lib/google/fetch'
import { __resetBucketsForTests } from '../../../src/lib/google/rate-limit'
import {
  GoogleAuthExpiredError,
  GoogleHttpError,
  InsufficientScopesError,
} from '../../../src/lib/google/errors'

type Init = { method?: string; headers?: Record<string, string>; body?: string }

function responder(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: Init }> = []
  let i = 0
  const fetch = vi.fn(async (url: string, init?: Init) => {
    calls.push({ url, init })
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    const text = JSON.stringify(r.body)
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => text,
      json: async () => r.body,
    }
  })
  return { fetch, calls }
}

function parseMultipart(init: Init | undefined) {
  const ct = init?.headers?.['Content-Type'] ?? ''
  const boundary = ct.match(/boundary=([^;]+)/)?.[1]?.replace(/^"|"$/g, '')
  expect(boundary, 'multipart boundary').toBeTruthy()
  const parts = (init?.body ?? '')
    .split(`--${boundary}`)
    .map((p) => p.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
    .filter((p) => p && p !== '--')
  return parts.map((part) => {
    const sep = part.indexOf('\r\n\r\n')
    return { headers: part.slice(0, sep), content: part.slice(sep + 4) }
  })
}

describe('google/docs-write createDocFromMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureFreshAccessToken.mockResolvedValue('tok-abc')
    mocks.assertScopes.mockResolvedValue(undefined)
    __setFetchSleeperForTests(async () => {})
  })
  afterEach(() => {
    __setRawFetchForTests(null)
    __resetBucketsForTests()
  })

  it('checks drive.file before any network call', async () => {
    mocks.assertScopes.mockRejectedValue(new InsufficientScopesError([DRIVE_FILE_SCOPE]))
    const { fetch } = responder([{ status: 200, body: { id: 'x' } }])
    __setRawFetchForTests(fetch)
    await expect(
      createDocFromMarkdown('user-1', { title: 'T', markdown: '# hi' })
    ).rejects.toBeInstanceOf(InsufficientScopesError)
    expect(mocks.assertScopes).toHaveBeenCalledWith('user-1', [DRIVE_FILE_SCOPE])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('POSTs a multipart/related body with JSON metadata and a text/markdown media part', async () => {
    const { fetch, calls } = responder([
      {
        status: 200,
        body: {
          id: 'doc1',
          name: 'Plan',
          webViewLink: 'https://docs.google.com/document/d/doc1/edit?usp=drivesdk',
        },
      },
    ])
    __setRawFetchForTests(fetch)
    const res = await createDocFromMarkdown('user-1', {
      title: 'Plan',
      markdown: '# Plan\n\n- one\n- two',
    })
    expect(res).toEqual({
      id: 'doc1',
      name: 'Plan',
      webViewLink: 'https://docs.google.com/document/d/doc1/edit?usp=drivesdk',
    })

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/upload/drive/v3/files')
    expect(u.searchParams.get('uploadType')).toBe('multipart')
    expect(u.searchParams.get('fields')).toBe('id,name,webViewLink')
    expect(u.searchParams.get('supportsAllDrives')).toBe('true')
    expect(init?.method).toBe('POST')
    expect(init?.headers?.Authorization).toBe('Bearer tok-abc')
    expect(init?.headers?.['Content-Type']).toMatch(/^multipart\/related; boundary=/)

    const parts = parseMultipart(init)
    expect(parts).toHaveLength(2)
    expect(parts[0].headers.toLowerCase()).toContain('application/json')
    expect(JSON.parse(parts[0].content)).toEqual({
      name: 'Plan',
      mimeType: 'application/vnd.google-apps.document',
    })
    expect(parts[1].headers.toLowerCase()).toContain('text/markdown')
    expect(parts[1].content).toBe('# Plan\n\n- one\n- two')
  })

  it('adds parents when a valid folderId is given and rejects an invalid one before fetching', async () => {
    const { fetch, calls } = responder([{ status: 200, body: { id: 'doc2' } }])
    __setRawFetchForTests(fetch)
    await createDocFromMarkdown('user-1', { title: 'T', markdown: 'x', folderId: 'folder_ABC-123' })
    const meta = JSON.parse(parseMultipart(calls[0].init)[0].content)
    expect(meta.parents).toEqual(['folder_ABC-123'])

    await expect(
      createDocFromMarkdown('user-1', { title: 'T', markdown: 'x', folderId: '../../tokeninfo' })
    ).rejects.toThrow(/Invalid folderId/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to the canonical doc URL when webViewLink is missing', async () => {
    __setRawFetchForTests(responder([{ status: 200, body: { id: 'doc3', name: 'T' } }]).fetch)
    const res = await createDocFromMarkdown('user-1', { title: 'T', markdown: 'x' })
    expect(res.webViewLink).toBe('https://docs.google.com/document/d/doc3/edit')
  })

  it('treats a response without an id as an HTTP error', async () => {
    __setRawFetchForTests(responder([{ status: 200, body: { name: 'T' } }]).fetch)
    await expect(
      createDocFromMarkdown('user-1', { title: 'T', markdown: 'x' })
    ).rejects.toBeInstanceOf(GoogleHttpError)
  })

  it('maps 401 → GoogleAuthExpiredError and 403 → InsufficientScopesError([drive.file])', async () => {
    __setRawFetchForTests(responder([{ status: 401, body: {} }]).fetch)
    await expect(
      createDocFromMarkdown('user-1', { title: 'T', markdown: 'x' })
    ).rejects.toBeInstanceOf(GoogleAuthExpiredError)

    __setRawFetchForTests(
      responder([{ status: 403, body: { error: { message: 'Insufficient Permission' } } }]).fetch
    )
    const err = await createDocFromMarkdown('user-1', { title: 'T', markdown: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(InsufficientScopesError)
    expect((err as InsufficientScopesError).missing).toEqual([DRIVE_FILE_SCOPE])
  })

  it('does NOT retry a 5xx: the create is not idempotent (exactly one request, GoogleHttpError)', async () => {
    const { fetch } = responder([
      { status: 503, body: {} },
      { status: 200, body: { id: 'dup' } },
    ])
    __setRawFetchForTests(fetch)
    const err = await createDocFromMarkdown('user-1', { title: 'T', markdown: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleHttpError)
    expect((err as GoogleHttpError).status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
