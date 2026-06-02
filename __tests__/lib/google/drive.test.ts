import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock oauth ───────────────────────────────────────────────────────────────
vi.mock('../../../src/lib/google/oauth', () => ({
  ensureFreshAccessToken: vi.fn().mockResolvedValue('test-access-token'),
}))

import { ensureFreshAccessToken } from '../../../src/lib/google/oauth'
import { __setGoogleFetchForTests } from '../../../src/lib/google/fetch'
import {
  parseDriveUrl,
  getFileMeta,
  listFolderRecursive,
} from '../../../src/lib/google/drive'
import {
  DriveNotFoundError,
  DriveForbiddenError,
  DriveTrashedError,
  GoogleHttpError,
} from '../../../src/lib/google/errors'

const mockEnsure = ensureFreshAccessToken as ReturnType<typeof vi.fn>

function makeResponse(status: number, body: unknown) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => bodyStr,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  }
}

function makeFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0
  return vi.fn(async () => {
    const r = responses[i++]
    return makeResponse(r.status, r.body)
  })
}

function makeFileResource(overrides: Partial<{
  id: string; name: string; mimeType: string; modifiedTime: string; size: string; trashed: boolean
}> = {}) {
  return {
    id: 'file-id-1',
    name: 'My Doc',
    mimeType: 'application/vnd.google-apps.document',
    modifiedTime: '2026-01-01T00:00:00Z',
    trashed: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockEnsure.mockResolvedValue('test-access-token')
})

afterEach(() => {
  __setGoogleFetchForTests(null)
})

// ─── parseDriveUrl (pure, E3) ─────────────────────────────────────────────────

describe('parseDriveUrl', () => {
  it('parses Google Doc URL → file', () => {
    const r = parseDriveUrl('https://docs.google.com/document/d/abc123/edit')
    expect(r).toEqual({ kind: 'file', id: 'abc123' })
  })

  it('parses Google Sheets URL → file', () => {
    const r = parseDriveUrl('https://docs.google.com/spreadsheets/d/abc123/edit')
    expect(r).toEqual({ kind: 'file', id: 'abc123' })
  })

  it('parses Google Slides URL → file', () => {
    const r = parseDriveUrl('https://docs.google.com/presentation/d/abc123/edit')
    expect(r).toEqual({ kind: 'file', id: 'abc123' })
  })

  it('parses drive.google.com/file/d/<ID>/view → file', () => {
    const r = parseDriveUrl('https://drive.google.com/file/d/abc123/view')
    expect(r).toEqual({ kind: 'file', id: 'abc123' })
  })

  it('parses drive.google.com/open?id=<ID> → file', () => {
    const r = parseDriveUrl('https://drive.google.com/open?id=abc123')
    expect(r).toEqual({ kind: 'file', id: 'abc123' })
  })

  it('parses drive.google.com/drive/folders/<ID> → folder', () => {
    const r = parseDriveUrl('https://drive.google.com/drive/folders/folderid1')
    expect(r).toEqual({ kind: 'folder', id: 'folderid1' })
  })

  it('parses drive.google.com/drive/u/<N>/folders/<ID> → folder', () => {
    const r = parseDriveUrl('https://drive.google.com/drive/u/0/folders/folderid2')
    expect(r).toEqual({ kind: 'folder', id: 'folderid2' })
  })

  it('tolerates trailing slash on docs URL', () => {
    const r = parseDriveUrl('https://docs.google.com/document/d/abc123/edit/')
    expect(r).toEqual({ kind: 'file', id: 'abc123' })
  })

  it('tolerates extra query params on docs URL', () => {
    const r = parseDriveUrl('https://docs.google.com/document/d/abc123/edit?usp=sharing')
    expect(r).toEqual({ kind: 'file', id: 'abc123' })
  })

  it('tolerates fragment on drive file URL', () => {
    const r = parseDriveUrl('https://drive.google.com/file/d/abc123/view#gid=0')
    expect(r).toEqual({ kind: 'file', id: 'abc123' })
  })

  it('returns null for non-Drive URL', () => {
    expect(parseDriveUrl('https://example.com/foo')).toBeNull()
  })

  it('returns null for Google Forms URL (unsupported)', () => {
    expect(parseDriveUrl('https://docs.google.com/forms/d/X/edit')).toBeNull()
  })

  it('returns null for bare string', () => {
    expect(parseDriveUrl('not a url')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseDriveUrl('')).toBeNull()
  })

  it('returns null for drive.google.com/drive/my-drive (no id)', () => {
    expect(parseDriveUrl('https://drive.google.com/drive/my-drive')).toBeNull()
  })

  // ─── id injection guard (SSRF/URL-injection: id is interpolated into a
  //     googleapis path carrying the user's OAuth Bearer token) ───────────────
  describe('rejects ids outside the Google file-id charset', () => {
    it('rejects path-traversal id via open?id= branch', () => {
      // searchParams.get('id') can return arbitrary strings; "../../tokeninfo"
      // would otherwise traverse to a different googleapis endpoint.
      expect(parseDriveUrl('https://drive.google.com/open?id=..%2F..%2Ftokeninfo')).toBeNull()
      expect(parseDriveUrl('https://drive.google.com/open?id=' + encodeURIComponent('../../tokeninfo'))).toBeNull()
    })

    it('rejects id with a slash, space, or query-injection char', () => {
      expect(parseDriveUrl('https://drive.google.com/open?id=' + encodeURIComponent('abc/def'))).toBeNull()
      expect(parseDriveUrl('https://drive.google.com/open?id=' + encodeURIComponent('abc def'))).toBeNull()
      expect(parseDriveUrl('https://drive.google.com/open?id=' + encodeURIComponent('abc?x=1'))).toBeNull()
      expect(parseDriveUrl('https://drive.google.com/open?id=' + encodeURIComponent('abc#frag'))).toBeNull()
    })

    it('rejects empty / dot-only id', () => {
      expect(parseDriveUrl('https://drive.google.com/open?id=' + encodeURIComponent('..'))).toBeNull()
    })

    it('NEGATIVE: still accepts a legitimate Drive id (alnum, _ and -)', () => {
      // false-positive boundary — the guard must not break real ids.
      const r = parseDriveUrl('https://drive.google.com/open?id=1A_b-2C3d4E5f6G7h8I9j0')
      expect(r).toEqual({ kind: 'file', id: '1A_b-2C3d4E5f6G7h8I9j0' })
    })
  })
})

// ─── getFileMeta ──────────────────────────────────────────────────────────────

describe('getFileMeta', () => {
  it('happy path: returns shaped DriveFileMeta with numeric sizeBytes from string', async () => {
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeFileResource({ size: '12345' }) },
    ]))

    const meta = await getFileMeta('user-1', 'file-id-1')

    expect(meta).toEqual({
      id: 'file-id-1',
      name: 'My Doc',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-01-01T00:00:00Z',
      sizeBytes: 12345,
      trashed: false,
    })
  })

  it('returns null sizeBytes for Google-native types (no size field)', async () => {
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeFileResource() }, // no size field
    ]))

    const meta = await getFileMeta('user-1', 'file-id-1')

    expect(meta.sizeBytes).toBeNull()
  })

  it('404 → DriveNotFoundError', async () => {
    __setGoogleFetchForTests(makeFetch([{ status: 404, body: 'not found' }]))

    await expect(getFileMeta('user-1', 'file-id-1')).rejects.toBeInstanceOf(DriveNotFoundError)
  })

  it('403 → DriveForbiddenError', async () => {
    __setGoogleFetchForTests(makeFetch([{ status: 403, body: 'forbidden' }]))

    await expect(getFileMeta('user-1', 'file-id-1')).rejects.toBeInstanceOf(DriveForbiddenError)
  })

  it('trashed: true → DriveTrashedError (E4)', async () => {
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeFileResource({ trashed: true }) },
    ]))

    await expect(getFileMeta('user-1', 'file-id-1')).rejects.toBeInstanceOf(DriveTrashedError)
  })

  it('5xx → GoogleHttpError with status', async () => {
    __setGoogleFetchForTests(makeFetch([{ status: 503, body: 'service unavailable' }]))

    const err = await getFileMeta('user-1', 'file-id-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleHttpError)
    expect((err as GoogleHttpError).status).toBe(503)
  })

  it('shortcut path: fetches target on second call and returns target meta', async () => {
    const shortcutResource = {
      ...makeFileResource({ mimeType: 'application/vnd.google-apps.shortcut' }),
      shortcutDetails: { targetId: 'target-id-X', targetMimeType: 'application/vnd.google-apps.document' },
    }
    const targetResource = makeFileResource({ id: 'target-id-X', name: 'Real Doc', size: '999' })

    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: shortcutResource },
      { status: 200, body: targetResource },
    ]))

    const meta = await getFileMeta('user-1', 'file-id-1')

    expect(meta.id).toBe('target-id-X')
    expect(meta.name).toBe('Real Doc')
    expect(meta.sizeBytes).toBe(999)
  })

  it('nested shortcut → throws GoogleHttpError with NESTED_SHORTCUT', async () => {
    const shortcut1 = {
      ...makeFileResource({ mimeType: 'application/vnd.google-apps.shortcut' }),
      shortcutDetails: { targetId: 'shortcut-2', targetMimeType: 'application/vnd.google-apps.shortcut' },
    }
    const shortcut2 = {
      ...makeFileResource({ id: 'shortcut-2', mimeType: 'application/vnd.google-apps.shortcut' }),
      shortcutDetails: { targetId: 'shortcut-3', targetMimeType: 'application/vnd.google-apps.shortcut' },
    }

    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: shortcut1 },
      { status: 200, body: shortcut2 },
    ]))

    const err = await getFileMeta('user-1', 'file-id-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleHttpError)
    expect((err as GoogleHttpError).body).toBe('NESTED_SHORTCUT')
  })
})

// ─── listFolderRecursive ──────────────────────────────────────────────────────

function makeListResponse(files: ReturnType<typeof makeFileResource>[], nextPageToken?: string) {
  return nextPageToken ? { files, nextPageToken } : { files }
}

function makeDoc(id: string, name: string, sizeBytes?: number) {
  return makeFileResource({
    id,
    name,
    mimeType: 'application/vnd.google-apps.document',
    ...(sizeBytes != null ? { size: String(sizeBytes) } : {}),
  })
}

function makeFolder(id: string, name: string) {
  return makeFileResource({ id, name, mimeType: 'application/vnd.google-apps.folder' })
}

const DEFAULT_OPTS = { maxDepth: 3, maxCount: 50, maxFileBytes: 5_242_880 }

describe('listFolderRecursive — E6 happy path', () => {
  it('3 supported docs → files.length===3, rejected===[]', async () => {
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeListResponse([makeDoc('d1', 'Alpha'), makeDoc('d2', 'Beta'), makeDoc('d3', 'Gamma')]) },
    ]))

    const result = await listFolderRecursive('user-1', 'folder-root', DEFAULT_OPTS)

    expect(result.files).toHaveLength(3)
    expect(result.rejected).toHaveLength(0)
    expect(result.files.map(f => f.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
})

describe('listFolderRecursive — E7 TOO_MANY_FILES', () => {
  it('60 docs → files.length===50, rejected.length===10 with TOO_MANY_FILES', async () => {
    const docs = Array.from({ length: 60 }, (_, i) => makeDoc(`d${String(i).padStart(3, '0')}`, `Doc${String(i).padStart(3, '0')}`))
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeListResponse(docs) },
    ]))

    const result = await listFolderRecursive('user-1', 'folder-root', DEFAULT_OPTS)

    expect(result.files).toHaveLength(50)
    expect(result.rejected).toHaveLength(10)
    expect(result.rejected.every(r => r.reason === 'TOO_MANY_FILES')).toBe(true)
    // The last 10 alphabetically are rejected
    const rejectedNames = result.rejected.map(r => r.name)
    expect(rejectedNames).toContain('Doc050')
    expect(rejectedNames).toContain('Doc059')
  })
})

describe('listFolderRecursive — E8 TOO_LARGE', () => {
  it('1 file >5MB and 1 file <5MB → files.length===1, rejected.length===1 with TOO_LARGE', async () => {
    const bigFile = makeDoc('big', 'BigFile', 6 * 1024 * 1024)
    const smallFile = makeDoc('small', 'SmallFile', 1 * 1024 * 1024)
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeListResponse([bigFile, smallFile]) },
    ]))

    const result = await listFolderRecursive('user-1', 'folder-root', DEFAULT_OPTS)

    expect(result.files).toHaveLength(1)
    expect(result.files[0].id).toBe('small')
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toMatchObject({ id: 'big', reason: 'TOO_LARGE' })
  })
})

describe('listFolderRecursive — E9 DEPTH_EXCEEDED', () => {
  it('F0→F1→F2→F3→F4(doc): maxDepth=3 → F4 rejected DEPTH_EXCEEDED, doc inside not enumerated', async () => {
    // Root (depth=1) contains F1 (depth=2)
    // F1 (depth=2) contains F2 (depth=3)
    // F2 (depth=3) contains F3 — depth=3 is maxDepth, so F3 would be at depth=4 → rejected
    // F3 contains a doc — not reached
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeListResponse([makeFolder('f1', 'F1')]) },       // root children
      { status: 200, body: makeListResponse([makeFolder('f2', 'F2')]) },       // F1 children
      { status: 200, body: makeListResponse([makeFolder('f3', 'F3')]) },       // F2 children — depth=3, F3 would be depth=4
    ]))

    const result = await listFolderRecursive('user-1', 'f0', { maxDepth: 3, maxCount: 50, maxFileBytes: 5_242_880 })

    expect(result.files).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toMatchObject({ id: 'f3', reason: 'DEPTH_EXCEEDED' })
  })
})

describe('listFolderRecursive — E10 silently skip unsupported types', () => {
  it('1 supported doc + 1 form → files.length===1, rejected.length===0', async () => {
    const doc = makeDoc('d1', 'GoodDoc')
    const form = makeFileResource({ id: 'f1', name: 'AForm', mimeType: 'application/vnd.google-apps.form' })
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeListResponse([doc, form]) },
    ]))

    const result = await listFolderRecursive('user-1', 'folder-root', DEFAULT_OPTS)

    expect(result.files).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })
})

describe('listFolderRecursive — E17 FORBIDDEN_CHILD', () => {
  it('child subfolder 403 → rejected with FORBIDDEN_CHILD; root files still enumerated', async () => {
    const rootChildren = [
      makeDoc('d1', 'Alpha'),
      makeFolder('sub1', 'SubFolder'),
      makeDoc('d2', 'Beta'),
    ]
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeListResponse(rootChildren) },  // root list
      { status: 403, body: 'forbidden' },                      // sub1 list → 403
    ]))

    const result = await listFolderRecursive('user-1', 'folder-root', DEFAULT_OPTS)

    expect(result.files).toHaveLength(2)
    expect(result.files.map(f => f.name)).toEqual(['Alpha', 'Beta'])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toMatchObject({ id: 'sub1', reason: 'FORBIDDEN_CHILD' })
  })
})

describe('listFolderRecursive — Pagination', () => {
  it('120 files across 2 pages → first 50 in files, 70 in rejected TOO_MANY_FILES', async () => {
    const firstPage = Array.from({ length: 70 }, (_, i) => makeDoc(`d${String(i).padStart(3, '0')}`, `Doc${String(i).padStart(3, '0')}`))
    const secondPage = Array.from({ length: 50 }, (_, i) => makeDoc(`d${String(i + 70).padStart(3, '0')}`, `Doc${String(i + 70).padStart(3, '0')}`))

    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeListResponse(firstPage, 'page-token-2') },
      { status: 200, body: makeListResponse(secondPage) },
    ]))

    const result = await listFolderRecursive('user-1', 'folder-root', DEFAULT_OPTS)

    expect(result.files).toHaveLength(50)
    expect(result.rejected).toHaveLength(70)
    expect(result.rejected.every(r => r.reason === 'TOO_MANY_FILES')).toBe(true)
  })
})

describe('listFolderRecursive — Token acquisition', () => {
  it('calls ensureFreshAccessToken exactly once at the start', async () => {
    __setGoogleFetchForTests(makeFetch([
      { status: 200, body: makeListResponse([makeDoc('d1', 'Doc1')]) },
    ]))

    await listFolderRecursive('user-1', 'folder-root', DEFAULT_OPTS)

    expect(mockEnsure).toHaveBeenCalledTimes(1)
    expect(mockEnsure).toHaveBeenCalledWith('user-1')
  })

  it('throws Error for maxDepth <= 0', async () => {
    await expect(
      listFolderRecursive('user-1', 'folder-root', { maxDepth: 0, maxCount: 50, maxFileBytes: 5_242_880 }),
    ).rejects.toThrow('Invalid FolderEnumOpts')
  })

  it('throws Error for maxCount <= 0', async () => {
    await expect(
      listFolderRecursive('user-1', 'folder-root', { maxDepth: 3, maxCount: 0, maxFileBytes: 5_242_880 }),
    ).rejects.toThrow('Invalid FolderEnumOpts')
  })
})
