import { googleFetch } from './fetch'
import { ensureFreshAccessToken } from './oauth'
import { DriveForbiddenError, DriveNotFoundError, GoogleHttpError } from './errors'

export async function exportDocAsMarkdown(userId: string, fileId: string): Promise<string> {
  const token = await ensureFreshAccessToken(userId)
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fmarkdown`
  const res = await googleFetch(url, { headers: { Authorization: `Bearer ${token}` } })

  if (res.status === 404) throw new DriveNotFoundError()
  if (res.status === 403) throw new DriveForbiddenError()
  if (!res.ok) throw new GoogleHttpError(res.status, await res.text())

  return res.text()
}
