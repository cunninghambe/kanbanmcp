export type GoogleSource = 'GOOGLE_DOC' | 'GOOGLE_SHEET' | 'GOOGLE_SLIDE' | 'GOOGLE_FOLDER'

const MIME_TO_SOURCE: Record<string, GoogleSource> = {
  'application/vnd.google-apps.document': 'GOOGLE_DOC',
  'application/vnd.google-apps.spreadsheet': 'GOOGLE_SHEET',
  'application/vnd.google-apps.presentation': 'GOOGLE_SLIDE',
  'application/vnd.google-apps.folder': 'GOOGLE_FOLDER',
}

export function mapMimeToSource(mimeType: string): GoogleSource | null {
  return MIME_TO_SOURCE[mimeType] ?? null
}

export function buildStorageKey(source: GoogleSource, id: string): string {
  return source === 'GOOGLE_FOLDER' ? `gdrive://folder/${id}` : `gdrive://${id}`
}
