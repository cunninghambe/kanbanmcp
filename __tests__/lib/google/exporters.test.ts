import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock oauth ───────────────────────────────────────────────────────────────
vi.mock('../../../src/lib/google/oauth', () => ({
  ensureFreshAccessToken: vi.fn().mockResolvedValue('test-access-token'),
}))

import { ensureFreshAccessToken } from '../../../src/lib/google/oauth'
import { __setGoogleFetchForTests } from '../../../src/lib/google/fetch'
import { exportDocAsMarkdown } from '../../../src/lib/google/docs'
import { exportSheetAsCsv, SHEETS_MAX_ROWS, SHEETS_MAX_COLS } from '../../../src/lib/google/sheets'
import { extractSlides, SLIDES_IMAGES_PER_SLIDE_CAP } from '../../../src/lib/google/slides'
import { DriveNotFoundError, DriveForbiddenError, GoogleHttpError } from '../../../src/lib/google/errors'

const mockEnsure = ensureFreshAccessToken as ReturnType<typeof vi.fn>

function makeResponse(status: number, body: unknown, opts: { bytes?: Uint8Array } = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => bodyStr,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => (opts.bytes ? opts.bytes.buffer : new ArrayBuffer(0)),
  }
}

function makeFetch(responses: Array<{ status: number; body: unknown; bytes?: Uint8Array }>) {
  let i = 0
  return vi.fn(async () => {
    const r = responses[i++]
    return makeResponse(r.status, r.body, { bytes: r.bytes })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockEnsure.mockResolvedValue('test-access-token')
})

afterEach(() => {
  __setGoogleFetchForTests(null)
})

// ─── Docs ─────────────────────────────────────────────────────────────────────

describe('exportDocAsMarkdown', () => {
  it('happy path: returns the response body string', async () => {
    __setGoogleFetchForTests(makeFetch([{ status: 200, body: '# Hello\n\nWorld' }]))
    const result = await exportDocAsMarkdown('user-1', 'doc-id')
    expect(result).toBe('# Hello\n\nWorld')
  })

  it('404 → DriveNotFoundError', async () => {
    __setGoogleFetchForTests(makeFetch([{ status: 404, body: 'not found' }]))
    await expect(exportDocAsMarkdown('user-1', 'doc-id')).rejects.toBeInstanceOf(DriveNotFoundError)
  })

  it('403 → DriveForbiddenError', async () => {
    __setGoogleFetchForTests(makeFetch([{ status: 403, body: 'forbidden' }]))
    await expect(exportDocAsMarkdown('user-1', 'doc-id')).rejects.toBeInstanceOf(DriveForbiddenError)
  })

  it('500 → GoogleHttpError with status 500', async () => {
    __setGoogleFetchForTests(makeFetch([{ status: 500, body: 'internal error' }]))
    const err = await exportDocAsMarkdown('user-1', 'doc-id').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleHttpError)
    expect((err as GoogleHttpError).status).toBe(500)
  })

  it('empty body → empty string', async () => {
    __setGoogleFetchForTests(makeFetch([{ status: 200, body: '' }]))
    const result = await exportDocAsMarkdown('user-1', 'doc-id')
    expect(result).toBe('')
  })
})

// ─── Sheets (E14) ─────────────────────────────────────────────────────────────

function makeMetaResponse(sheets: Array<{ title: string; rowCount?: number; colCount?: number }>) {
  return {
    sheets: sheets.map((s) => ({
      properties: {
        title: s.title,
        gridProperties: { rowCount: s.rowCount ?? 3, columnCount: s.colCount ?? 3 },
      },
    })),
  }
}

function makeValuesResponse(values: string[][]) {
  return { values }
}

describe('exportSheetAsCsv', () => {
  it('single tab, 3 rows × 3 cols → header + 3 CSV lines', async () => {
    const meta = makeMetaResponse([{ title: 'Sheet1', rowCount: 3 }])
    const values = makeValuesResponse([['a', 'b', 'c'], ['1', '2', '3'], ['x', 'y', 'z']])
    __setGoogleFetchForTests(makeFetch([{ status: 200, body: meta }, { status: 200, body: values }]))

    const result = await exportSheetAsCsv('user-1', 'sheet-id')

    expect(result).toBe('## Sheet: Sheet1\na,b,c\n1,2,3\nx,y,z')
  })

  it('two tabs → concatenated with \\n\\n', async () => {
    const meta = makeMetaResponse([
      { title: 'Tab A', rowCount: 1 },
      { title: 'Tab B', rowCount: 1 },
    ])
    const valA = makeValuesResponse([['hello']])
    const valB = makeValuesResponse([['world']])
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: meta },
      { status: 200, body: valA },
      { status: 200, body: valB },
    ]))

    const result = await exportSheetAsCsv('user-1', 'sheet-id')

    expect(result).toBe('## Sheet: Tab A\nhello\n\n## Sheet: Tab B\nworld')
  })

  it('E14: 150 rows → rows 1..100 then truncation notice', async () => {
    const meta = makeMetaResponse([{ title: 'Big', rowCount: 150 }])
    const values = makeValuesResponse(Array.from({ length: 150 }, (_, i) => [`row${i + 1}`]))
    __setGoogleFetchForTests(makeFetch([{ status: 200, body: meta }, { status: 200, body: values }]))

    const result = await exportSheetAsCsv('user-1', 'sheet-id')
    const lines = result.replace('## Sheet: Big\n', '').split('\n')

    expect(lines).toHaveLength(SHEETS_MAX_ROWS + 1) // 100 data rows + truncation line
    expect(lines[SHEETS_MAX_ROWS]).toBe(`... (${150 - SHEETS_MAX_ROWS} rows truncated)`)
    expect(lines[0]).toBe('row1')
    expect(lines[SHEETS_MAX_ROWS - 1]).toBe('row100')
  })

  it('E14: 30 columns → only first 26 columns emitted', async () => {
    const meta = makeMetaResponse([{ title: 'Wide', rowCount: 1, colCount: 30 }])
    const row = Array.from({ length: 30 }, (_, i) => `col${i + 1}`)
    const values = makeValuesResponse([row])
    __setGoogleFetchForTests(makeFetch([{ status: 200, body: meta }, { status: 200, body: values }]))

    const result = await exportSheetAsCsv('user-1', 'sheet-id')
    const csvLine = result.replace('## Sheet: Wide\n', '')
    const cols = csvLine.split(',')

    expect(cols).toHaveLength(SHEETS_MAX_COLS)
    expect(cols[0]).toBe('col1')
    expect(cols[25]).toBe('col26')
  })

  it('CSV quoting: cell with comma and quotes → properly escaped', async () => {
    const meta = makeMetaResponse([{ title: 'Q', rowCount: 1 }])
    const values = makeValuesResponse([['Hello, "world"']])
    __setGoogleFetchForTests(makeFetch([{ status: 200, body: meta }, { status: 200, body: values }]))

    const result = await exportSheetAsCsv('user-1', 'sheet-id')

    expect(result).toContain('"Hello, ""world"""')
  })

  it('tab title with special characters → URL-encoded in values fetch URL', async () => {
    const meta = makeMetaResponse([{ title: "Foo/Bar's", rowCount: 1 }])
    const values = makeValuesResponse([['val']])
    const fetchMock = makeFetch([{ status: 200, body: meta }, { status: 200, body: values }])
    __setGoogleFetchForTests(fetchMock)

    await exportSheetAsCsv('user-1', 'sheet-id')

    const calls = fetchMock.mock.calls as unknown as [string, ...unknown[]][]
    const valuesUrl = calls[1][0]
    expect(valuesUrl).toContain(encodeURIComponent("Foo/Bar's"))
  })
})

// ─── Slides (E13) ─────────────────────────────────────────────────────────────

function makePresentation(slides: Array<{
  texts?: string[]
  imageUrls?: string[]
}>) {
  return {
    slides: slides.map((slide) => ({
      objectId: `slide-${Math.random()}`,
      pageElements: [
        ...(slide.texts ?? []).map((t) => ({
          shape: {
            text: {
              textElements: [{ textRun: { content: t } }],
            },
          },
        })),
        ...(slide.imageUrls ?? []).map((url) => ({
          image: { contentUrl: url },
        })),
      ],
    })),
  }
}

describe('extractSlides', () => {
  it('slide with two text shapes + zero images → text joined by \\n, imageDataUrls === []', async () => {
    const pres = makePresentation([{ texts: ['Hello', 'World'] }])
    __setGoogleFetchForTests(makeFetch([{ status: 200, body: pres }]))

    const result = await extractSlides('user-1', 'pres-id')

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Hello\nWorld')
    expect(result[0].imageDataUrls).toEqual([])
  })

  it('slide with one image → imageDataUrls[0] is correct base64', async () => {
    const pres = makePresentation([{ imageUrls: ['https://img.example.com/1.png'] }])
    const imgBytes = new Uint8Array([0xde, 0xad, 0xbe])
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: pres },
      { status: 200, body: '', bytes: imgBytes },
    ]))

    const result = await extractSlides('user-1', 'pres-id')

    expect(result[0].imageDataUrls).toHaveLength(1)
    expect(result[0].imageDataUrls[0]).toBe(Buffer.from(imgBytes).toString('base64'))
  })

  it('E13: slide with 7 images → first 5 captured; text ends with truncation note', async () => {
    const imageUrls = Array.from({ length: 7 }, (_, i) => `https://img.example.com/${i}.png`)
    const pres = makePresentation([{ imageUrls }])
    const imgBytes = new Uint8Array([1, 2, 3])
    const responses = [
      { status: 200, body: pres },
      ...Array.from({ length: SLIDES_IMAGES_PER_SLIDE_CAP }, () => ({ status: 200, body: '', bytes: imgBytes })),
    ]
    __setGoogleFetchForTests(makeFetch(responses))

    const result = await extractSlides('user-1', 'pres-id')

    expect(result[0].imageDataUrls).toHaveLength(SLIDES_IMAGES_PER_SLIDE_CAP)
    expect(result[0].text).toContain('[2 additional images not included]')
  })

  it('image fetch 404 mid-slide → skipped silently; remaining images included', async () => {
    const imageUrls = ['https://img.example.com/a.png', 'https://img.example.com/b.png', 'https://img.example.com/c.png']
    const pres = makePresentation([{ imageUrls }])
    const imgBytes = new Uint8Array([0xff])
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: pres },
      { status: 200, body: '', bytes: imgBytes },
      { status: 404, body: 'not found' },
      { status: 200, body: '', bytes: imgBytes },
    ]))

    const result = await extractSlides('user-1', 'pres-id')

    expect(result[0].imageDataUrls).toHaveLength(2)
  })

  it('presentation with 3 slides → output length 3, slideIndex 1 2 3', async () => {
    const pres = makePresentation([
      { texts: ['Slide one'] },
      { texts: ['Slide two'] },
      { texts: ['Slide three'] },
    ])
    __setGoogleFetchForTests(makeFetch([{ status: 200, body: pres }]))

    const result = await extractSlides('user-1', 'pres-id')

    expect(result).toHaveLength(3)
    expect(result.map((s) => s.slideIndex)).toEqual([1, 2, 3])
  })

  it('token-refresh integration: ensureFreshAccessToken called exactly once regardless of image fetches', async () => {
    const imageUrls = ['https://img.example.com/1.png', 'https://img.example.com/2.png']
    const pres = makePresentation([{ imageUrls }])
    const imgBytes = new Uint8Array([0xaa])
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: pres },
      { status: 200, body: '', bytes: imgBytes },
      { status: 200, body: '', bytes: imgBytes },
    ]))

    await extractSlides('user-1', 'pres-id')

    expect(mockEnsure).toHaveBeenCalledTimes(1)
    expect(mockEnsure).toHaveBeenCalledWith('user-1')
  })
})
