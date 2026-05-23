import { googleFetch } from './fetch'
import { ensureFreshAccessToken } from './oauth'
import { DriveForbiddenError, DriveNotFoundError, DriveTrashedError, GoogleHttpError } from './errors'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DriveFileMeta {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  sizeBytes: number | null
  trashed: boolean
}

export interface ParsedDriveUrl {
  kind: 'file' | 'folder'
  id: string
}

export interface FolderEnumOpts {
  maxDepth: number
  maxCount: number
  maxFileBytes: number
}

export type RejectionReason =
  | 'TOO_MANY_FILES'
  | 'TOO_LARGE'
  | 'DEPTH_EXCEEDED'
  | 'FORBIDDEN_CHILD'
  | 'UNSUPPORTED_TYPE'

export interface FolderEnumResult {
  files: DriveFileMeta[]
  rejected: Array<{ id: string; name?: string; reason: RejectionReason }>
}

// ─── Internal Drive response types ───────────────────────────────────────────

type DriveFileResource = {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  size?: string
  trashed: boolean
  shortcutDetails?: { targetId: string; targetMimeType: string }
}

type DriveListResponse = {
  files: DriveFileResource[]
  nextPageToken?: string
}

// ─── Supported MIME types ─────────────────────────────────────────────────────

const SUPPORTED_FILE_MIMES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
])

const FOLDER_MIME = 'application/vnd.google-apps.folder'

// ─── parseDriveUrl ────────────────────────────────────────────────────────────

const FILE_PATTERNS: RegExp[] = [
  /^https:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([^/?#]+)/i,
  /^https:\/\/drive\.google\.com\/file\/d\/([^/?#]+)/i,
]

const FOLDER_PATTERNS: RegExp[] = [
  /^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([^/?#]+)/i,
]

const OPEN_PATTERN = /^https:\/\/drive\.google\.com\/open\?/i

export function parseDriveUrl(url: string): ParsedDriveUrl | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  for (const pattern of FILE_PATTERNS) {
    const match = pattern.exec(trimmed)
    if (match) return { kind: 'file', id: match[1] }
  }

  for (const pattern of FOLDER_PATTERNS) {
    const match = pattern.exec(trimmed)
    if (match) return { kind: 'folder', id: match[1] }
  }

  if (OPEN_PATTERN.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      const id = parsed.searchParams.get('id')
      if (id) return { kind: 'file', id }
    } catch {
      return null
    }
  }

  return null
}

// ─── getFileMeta ──────────────────────────────────────────────────────────────

function shapeFileMeta(resource: DriveFileResource): DriveFileMeta {
  return {
    id: resource.id,
    name: resource.name,
    mimeType: resource.mimeType,
    modifiedTime: resource.modifiedTime,
    sizeBytes: resource.size != null ? parseInt(resource.size, 10) : null,
    trashed: resource.trashed,
  }
}

async function fetchFileResource(fileId: string, token: string): Promise<DriveFileResource> {
  const fields = 'id,name,mimeType,modifiedTime,size,trashed,shortcutDetails'
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=${fields}&supportsAllDrives=true`
  const res = await googleFetch(url, { headers: { Authorization: `Bearer ${token}` } })

  if (res.status === 404) throw new DriveNotFoundError()
  if (res.status === 403) throw new DriveForbiddenError()
  if (!res.ok) throw new GoogleHttpError(res.status, await res.text())

  return res.json() as Promise<DriveFileResource>
}

export async function getFileMeta(userId: string, fileId: string): Promise<DriveFileMeta> {
  const token = await ensureFreshAccessToken(userId)
  const resource = await fetchFileResource(fileId, token)

  if (resource.trashed) throw new DriveTrashedError()

  if (resource.mimeType === 'application/vnd.google-apps.shortcut') {
    const targetId = resource.shortcutDetails?.targetId
    if (!targetId) throw new GoogleHttpError(0, 'NESTED_SHORTCUT')

    const target = await fetchFileResource(targetId, token)
    if (target.mimeType === 'application/vnd.google-apps.shortcut') {
      throw new GoogleHttpError(0, 'NESTED_SHORTCUT')
    }
    return shapeFileMeta(target)
  }

  return shapeFileMeta(resource)
}

// ─── listFolderRecursive ──────────────────────────────────────────────────────

async function fetchFolderPage(
  folderId: string,
  token: string,
  pageToken?: string,
): Promise<DriveListResponse> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,size,trashed),nextPageToken')
  let url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=100&orderBy=name`
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`

  const res = await googleFetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 403) throw new DriveForbiddenError()
  if (!res.ok) throw new GoogleHttpError(res.status, await res.text())

  return res.json() as Promise<DriveListResponse>
}

async function fetchAllChildren(
  folderId: string,
  token: string,
): Promise<DriveFileResource[]> {
  const all: DriveFileResource[] = []
  let pageToken: string | undefined

  do {
    const page = await fetchFolderPage(folderId, token, pageToken)
    all.push(...page.files)
    pageToken = page.nextPageToken
  } while (pageToken)

  return all
}

type BfsEntry = { folderId: string; depth: number }

export async function listFolderRecursive(
  userId: string,
  folderId: string,
  opts: FolderEnumOpts,
): Promise<FolderEnumResult> {
  if (opts.maxDepth <= 0 || opts.maxCount <= 0) throw new Error('Invalid FolderEnumOpts')

  const token = await ensureFreshAccessToken(userId)
  const result: FolderEnumResult = { files: [], rejected: [] }
  const queue: BfsEntry[] = [{ folderId, depth: 1 }]

  while (queue.length > 0) {
    const entry = queue.shift()!
    let children: DriveFileResource[]

    try {
      children = await fetchAllChildren(entry.folderId, token)
    } catch (err) {
      if (err instanceof DriveForbiddenError) {
        result.rejected.push({ id: entry.folderId, reason: 'FORBIDDEN_CHILD' })
        continue
      }
      throw err
    }

    for (const child of children) {
      if (child.mimeType === FOLDER_MIME) {
        if (entry.depth >= opts.maxDepth) {
          result.rejected.push({ id: child.id, name: child.name, reason: 'DEPTH_EXCEEDED' })
        } else {
          queue.push({ folderId: child.id, depth: entry.depth + 1 })
        }
        continue
      }

      if (!SUPPORTED_FILE_MIMES.has(child.mimeType)) continue

      const sizeBytes = child.size != null ? parseInt(child.size, 10) : null
      if (sizeBytes !== null && sizeBytes > opts.maxFileBytes) {
        result.rejected.push({ id: child.id, name: child.name, reason: 'TOO_LARGE' })
        continue
      }

      if (result.files.length >= opts.maxCount) {
        result.rejected.push({ id: child.id, name: child.name, reason: 'TOO_MANY_FILES' })
        continue
      }

      result.files.push(shapeFileMeta(child))
    }
  }

  return result
}
