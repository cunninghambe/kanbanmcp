// Day windows in the user's IANA time zone, without a date library.
// Spec: docs/specs/mhud-today-planner.md §4.2.

import type { DayWindow } from './types'

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number }

function localParts(at: Date, tz: string): Parts {
  const out: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(at)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return {
    y: out.year,
    m: out.month,
    d: out.day,
    // Some engines emit 24 for midnight with hour12 formats; h23 avoids it, but guard anyway.
    h: out.hour === 24 ? 0 : out.hour,
    mi: out.minute,
    s: out.second,
  }
}

/** Offset of `tz` from UTC at instant `at`, in minutes (e.g. Europe/London in July → 60). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  if (!isValidTimeZone(tz)) throw new RangeError(`Invalid time zone: ${tz}`)
  const p = localParts(at, tz)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s)
  // Drop sub-second precision on `at` so the division is exact.
  const base = Math.floor(at.getTime() / 1000) * 1000
  return Math.round((asUtc - base) / 60_000)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 'YYYY-MM-DD' of `at` in `tz`. */
export function localDate(at: Date, tz: string): string {
  if (!isValidTimeZone(tz)) throw new RangeError(`Invalid time zone: ${tz}`)
  const p = localParts(at, tz)
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`
}

function parseDate(date: string): { y: number; m: number; d: number } {
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new RangeError(`Invalid date: ${date}`)
  const [y, m, d] = date.split('-').map(Number)
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new RangeError(`Invalid date: ${date}`)
  }
  return { y, m, d }
}

/** Calendar arithmetic on 'YYYY-MM-DD' (no time zone involved). */
export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** The UTC instant of local midnight on `date` in `tz` (DST-safe). */
function localMidnightUtc(date: string, tz: string): Date {
  const { y, m, d } = parseDate(date)
  const wall = Date.UTC(y, m - 1, d)
  // First guess with the offset in force at the wall-clock instant read as UTC,
  // then correct once with the offset at the candidate — this handles a DST
  // transition between the two.
  let candidate = wall - tzOffsetMinutes(new Date(wall), tz) * 60_000
  const offsetAtCandidate = tzOffsetMinutes(new Date(candidate), tz)
  candidate = wall - offsetAtCandidate * 60_000
  return new Date(candidate)
}

/** [local 00:00, next local 00:00) as UTC instants. Throws RangeError on bad input. */
export function dayBounds(date: string, tz: string): DayWindow {
  if (!isValidTimeZone(tz)) throw new RangeError(`Invalid time zone: ${tz}`)
  const start = localMidnightUtc(date, tz)
  const end = localMidnightUtc(addDays(date, 1), tz)
  return { start, end }
}
