// Deterministic quick-capture parser for HUD entries: extracts an `@mention`
// and a `due:` token from raw chair-typed text. Pure, no I/O, no LLM — see
// docs/specs/2026-07-13-hud-meeting-manager.md §3.2 for the token rules.

export interface ParsedCapture {
  /** Residual text with recognized tokens removed and whitespace collapsed. */
  text: string
  /** First `@word` token (without the @), or null. Unresolved — server matches it. */
  assigneeQuery: string | null
  /** Resolved from the first recognized `due:` token, or null. */
  dueDate: Date | null
}

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// `@word` at a word boundary: start of string or preceded by whitespace.
const MENTION_PATTERN = /(^|\s)@(\w+)/

// Every `due:<value>` occurrence, value = run of non-whitespace chars.
const DUE_TOKEN_PATTERN = /due:(\S+)/gi

/**
 * Parses raw quick-capture text into residual text plus an unresolved
 * assignee query and a resolved due date. Never throws — callers decide how
 * to handle an empty residual `text`.
 */
export function parseCapture(raw: string, now: Date): ParsedCapture {
  let text = raw

  const mention = extractMention(text)
  if (mention) text = text.slice(0, mention.start) + text.slice(mention.end)

  const due = extractDueDate(text, now)
  if (due) text = text.slice(0, due.start) + text.slice(due.end)

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    assigneeQuery: mention ? mention.query : null,
    dueDate: due ? due.date : null,
  }
}

function extractMention(text: string): { query: string; start: number; end: number } | null {
  const match = MENTION_PATTERN.exec(text)
  if (!match) return null
  const start = match.index + match[1].length
  const end = start + 1 + match[2].length
  return { query: match[2], start, end }
}

/** Scans every `due:` occurrence left to right and returns the first one that resolves. */
function extractDueDate(text: string, now: Date): { date: Date; start: number; end: number } | null {
  for (const match of text.matchAll(DUE_TOKEN_PATTERN)) {
    const date = resolveDueValue(match[1], now)
    if (date) return { date, start: match.index, end: match.index + match[0].length }
  }
  return null
}

function resolveDueValue(value: string, now: Date): Date | null {
  const lower = value.toLowerCase()
  if (lower === 'today') return startOfDay(now)
  if (lower === 'tomorrow') return addDays(startOfDay(now), 1)

  const weekdayIndex = WEEKDAY_NAMES.indexOf(lower)
  if (weekdayIndex !== -1) {
    const today = startOfDay(now)
    const daysUntil = (weekdayIndex - today.getDay() + 7) % 7 || 7
    return addDays(today, daysUntil)
  }

  return resolveIsoDate(value)
}

/** `YYYY-MM-DD` → local midnight, or null if not a real calendar date. */
function resolveIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  const isRealDate =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  return isRealDate ? date : null
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}
