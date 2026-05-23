import { googleFetch } from './fetch'
import { ensureFreshAccessToken } from './oauth'
import { DriveForbiddenError, DriveNotFoundError, GoogleHttpError } from './errors'

export const SHEETS_MAX_ROWS = 100
export const SHEETS_MAX_COLS = 26

// ─── Internal response types ──────────────────────────────────────────────────

type SheetProperties = {
  title: string
  gridProperties?: { rowCount?: number; columnCount?: number }
}

type SpreadsheetsMetaResponse = {
  sheets: Array<{ properties: SheetProperties }>
}

type ValuesResponse = {
  values?: string[][]
}

// ─── CSV quoting (RFC-4180) ───────────────────────────────────────────────────

function quoteCsvField(value: string): string {
  if (!/[,"\n\r]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function rowToCsv(cells: string[]): string {
  return cells.map(quoteCsvField).join(',')
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function throwOnError(status: number, body: () => Promise<string>): void | Promise<never> {
  if (status === 404) throw new DriveNotFoundError()
  if (status === 403) throw new DriveForbiddenError()
  if (status < 200 || status >= 300) return body().then((b) => { throw new GoogleHttpError(status, b) })
}

async function fetchMeta(fileId: string, token: string): Promise<SpreadsheetsMetaResponse> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets.properties(title,gridProperties)`
  const res = await googleFetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const maybeThrow = throwOnError(res.status, () => res.text())
  if (maybeThrow) await maybeThrow
  return res.json() as Promise<SpreadsheetsMetaResponse>
}

async function fetchValues(fileId: string, title: string, token: string): Promise<ValuesResponse> {
  const encoded = encodeURIComponent(title)
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encoded}?majorDimension=ROWS`
  const res = await googleFetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const maybeThrow = throwOnError(res.status, () => res.text())
  if (maybeThrow) await maybeThrow
  return res.json() as Promise<ValuesResponse>
}

// ─── Per-tab CSV builder ──────────────────────────────────────────────────────

function buildTabCsv(rows: string[][], totalRows: number): string {
  const truncatedRows = rows.slice(0, SHEETS_MAX_COLS > 0 ? rows.length : 0)
  const lines = truncatedRows.map((row) => rowToCsv(row.slice(0, SHEETS_MAX_COLS)))

  if (totalRows > SHEETS_MAX_ROWS) {
    lines.push(`... (${totalRows - SHEETS_MAX_ROWS} rows truncated)`)
  }

  return lines.join('\n')
}

// ─── Public export ────────────────────────────────────────────────────────────

export async function exportSheetAsCsv(userId: string, fileId: string): Promise<string> {
  const token = await ensureFreshAccessToken(userId)
  const meta = await fetchMeta(fileId, token)

  const parts: string[] = []

  for (const sheet of meta.sheets) {
    const title = sheet.properties.title
    const totalRows = sheet.properties.gridProperties?.rowCount ?? 0
    const valuesRes = await fetchValues(fileId, title, token)
    const rawRows = (valuesRes.values ?? []).slice(0, SHEETS_MAX_ROWS)
    const csv = buildTabCsv(rawRows, totalRows)
    parts.push(`## Sheet: ${title}\n${csv}`)
  }

  return parts.join('\n\n')
}
