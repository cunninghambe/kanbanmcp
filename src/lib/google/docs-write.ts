// Create a Google Doc from Markdown via a Drive multipart upload (spec §4.6).
// Drive converts the text/markdown media part into a Google Doc.

import { randomBytes } from 'node:crypto'
import { googleFetch } from './fetch'
import { ensureFreshAccessToken } from './oauth'
import { assertScopes, DRIVE_FILE_SCOPE } from './scopes'
import { GoogleAuthExpiredError, GoogleHttpError, InsufficientScopesError } from './errors'

const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files'
const DOC_MIME_TYPE = 'application/vnd.google-apps.document'

// Same charset as drive.ts:84 — a folder id is interpolated into a request that
// carries the user's Bearer token, so anything else is rejected outright.
const DRIVE_ID = /^[A-Za-z0-9_-]+$/

export interface CreatedDoc {
  id: string
  name: string
  webViewLink: string
}

type CreateResponse = { id?: unknown; name?: unknown; webViewLink?: unknown }

function buildMultipartBody(
  boundary: string,
  metadata: Record<string, unknown>,
  markdown: string
): string {
  return [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/markdown; charset=UTF-8',
    '',
    markdown,
    `--${boundary}--`,
  ].join('\r\n')
}

export async function createDocFromMarkdown(
  userId: string,
  args: { title: string; markdown: string; folderId?: string }
): Promise<CreatedDoc> {
  const { title, markdown, folderId } = args
  if (folderId !== undefined && !DRIVE_ID.test(folderId)) throw new Error('Invalid folderId')

  await assertScopes(userId, [DRIVE_FILE_SCOPE])
  const token = await ensureFreshAccessToken(userId)

  const metadata: Record<string, unknown> = { name: title, mimeType: DOC_MIME_TYPE }
  if (folderId) metadata.parents = [folderId]

  const boundary = `mhud-${randomBytes(16).toString('hex')}`
  const url = `${UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`

  // retry is deliberately OFF: the multipart create carries no request id, so a
  // retried 5xx that had in fact created the file would leave a duplicate doc.
  const res = await googleFetch(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: buildMultipartBody(boundary, metadata, markdown),
    },
    { userId }
  )

  if (res.status === 401) throw new GoogleAuthExpiredError()
  if (res.status === 403) throw new InsufficientScopesError([DRIVE_FILE_SCOPE])
  if (!res.ok) throw new GoogleHttpError(res.status, await res.text())

  const body = (await res.json()) as CreateResponse
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) throw new GoogleHttpError(200, 'Unexpected create response shape')

  return {
    id,
    name: typeof body.name === 'string' ? body.name : title,
    webViewLink:
      typeof body.webViewLink === 'string' && body.webViewLink !== ''
        ? body.webViewLink
        : `https://docs.google.com/document/d/${id}/edit`,
  }
}
