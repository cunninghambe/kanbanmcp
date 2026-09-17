// Deterministic ranking for the Today planner.
// Spec: docs/specs/mhud-today-planner.md §4.3 (scores and reason strings) and
// §1.3 (sections).
//
// This module is PURE: it never reads the clock or the process time zone. The
// instant, the day window and the user's IANA zone all arrive in RankContext,
// so the same inputs always produce the same ranking (and the tests can pin it).

import { localDate } from './time'
import type {
  DayWindow,
  PlannerItemDTO,
  PlannerPriority,
  PlannerSection,
  RankedItemDTO,
} from './types'

export interface RankContext {
  now: Date
  window: DayWindow
  tz: string
}

export const NOW_MIN_SCORE = 25
export const NOW_MAX_ITEMS = 3
export const TODAY_MIN_SCORE = 12
export const SOON_MIN_SCORE = 5
export const SOON_DAYS = 7
export const MEETING_IMMINENT_MS = 15 * 60 * 1000 // → 80
export const MEETING_NEAR_MS = 60 * 60 * 1000 // → 50
export const MEETING_SOON_MS = 2 * 60 * 60 * 1000 // → 30
export const MEETING_NOW_SCORE = 65
export const ALL_DAY_SCORE = 3

const DAY_MS = 24 * 60 * 60 * 1000
const OVERDUE_BASE = 40
const OVERDUE_PER_DAY = 2
const OVERDUE_MAX_DAYS = 10
const DUE_TODAY_SCORE = 30
const DUE_TOMORROW_SCORE = 15
const DUE_THIS_WEEK_SCORE = 6
const URGENT_EMAIL_SCORE = 30
const EMAIL_SCORE = 10
const SLACK_DM_SCORE = 12
const SLACK_MENTION_SCORE = 10
const MANUAL_SCORE = 5
const REVIEW_SCORE = 5
const MEETING_IMMINENT_SCORE = 80
const MEETING_NEAR_SCORE = 50
const MEETING_SOON_SCORE = 30
const MEETING_TODAY_SCORE = 20
const AGE_MAX_DAYS = 7
const AGE_REASON_MIN_DAYS = 2
const BACK_FROM_SNOOZE_SCORE = 5

const PRIORITY_SCORE: Record<PlannerPriority, number> = {
  none: 0,
  low: 3,
  medium: 8,
  high: 15,
  critical: 25,
}

/** Parses an ISO string to epoch ms; null/unparseable → null. */
function ms(value: string | null): number | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : t
}

function isResolved(status: PlannerItemDTO['status']): boolean {
  return status === 'done' || status === 'dismissed' || status === 'wont_do'
}

/** A snoozed item whose snooze has elapsed ranks like an open one. */
function isSnoozeActive(item: PlannerItemDTO, now: number): boolean {
  if (item.status !== 'snoozed') return false
  const until = ms(item.snoozedUntil)
  return until !== null && until > now
}

function minutesUntil(deltaMs: number): number {
  return Math.ceil(deltaMs / 60_000)
}

/** The calendar rows of the scoring table, in table order. */
function scoreCalendar(
  item: PlannerItemDTO,
  ctx: RankContext,
  add: (points: number, reason: string) => void
): void {
  if (item.payload.allDay === true) {
    add(ALL_DAY_SCORE, 'all day')
    return
  }
  const now = ctx.now.getTime()
  const startsAt = ms(item.startsAt)
  const endsAt = ms(item.endsAt)
  if (startsAt === null) return

  if (startsAt <= now && endsAt !== null && now < endsAt) {
    add(MEETING_NOW_SCORE, 'meeting now')
    return
  }
  if (startsAt > now) {
    const delta = startsAt - now
    if (delta <= MEETING_IMMINENT_MS) {
      add(MEETING_IMMINENT_SCORE, `meeting in ${minutesUntil(delta)}m`)
    } else if (delta <= MEETING_NEAR_MS) {
      add(MEETING_NEAR_SCORE, `meeting in ${minutesUntil(delta)}m`)
    } else if (delta <= MEETING_SOON_MS) {
      add(MEETING_SOON_SCORE, `meeting in ${minutesUntil(delta)}m`)
    } else if (startsAt < ctx.window.end.getTime()) {
      add(MEETING_TODAY_SCORE, 'meeting today')
    } else {
      add(0, `meeting ${localDate(new Date(startsAt), ctx.tz)}`)
    }
    return
  }
  // started in the past and either ended or has no end instant
  if (endsAt !== null && endsAt <= now) add(0, 'meeting ended')
}

/**
 * Additive score plus the reason chips, produced in the exact order of the
 * table in §4.3. Resolved items score 0 with no reasons.
 */
export function scoreItem(
  item: PlannerItemDTO,
  ctx: RankContext
): { score: number; reasons: string[] } {
  if (isResolved(item.status)) return { score: 0, reasons: [] }

  let score = 0
  const reasons: string[] = []
  const add = (points: number, reason: string): void => {
    score += points
    reasons.push(reason)
  }

  const now = ctx.now.getTime()
  const windowStart = ctx.window.start.getTime()
  const windowEnd = ctx.window.end.getTime()

  const dueAt = ms(item.dueAt)
  if (dueAt !== null) {
    if (dueAt < now) {
      const days = Math.floor((now - dueAt) / DAY_MS)
      add(
        OVERDUE_BASE + OVERDUE_PER_DAY * Math.min(days, OVERDUE_MAX_DAYS),
        days === 0 ? 'overdue today' : `overdue ${days}d`
      )
    } else if (dueAt >= windowStart && dueAt < windowEnd) {
      add(DUE_TODAY_SCORE, 'due today')
    } else if (dueAt >= windowEnd && dueAt < windowEnd + DAY_MS) {
      add(DUE_TOMORROW_SCORE, 'due tomorrow')
    } else if (dueAt >= windowEnd + DAY_MS && dueAt < windowEnd + SOON_DAYS * DAY_MS) {
      add(DUE_THIS_WEEK_SCORE, 'due this week')
    }
  }

  if (item.priority !== 'none') add(PRIORITY_SCORE[item.priority], item.priority)

  if (item.source === 'email') {
    if (item.payload.urgent === true) add(URGENT_EMAIL_SCORE, 'urgent email')
    else add(EMAIL_SCORE, 'email')
  } else if (item.source === 'slack') {
    if (item.payload.kind === 'dm') add(SLACK_DM_SCORE, 'slack dm')
    else if (item.payload.kind === 'mention') add(SLACK_MENTION_SCORE, 'slack mention')
  } else if (item.source === 'manual') {
    add(MANUAL_SCORE, 'your to-do')
  } else if (item.source === 'card') {
    if (item.payload.role === 'reviewer' || item.payload.role === 'approver') {
      add(REVIEW_SCORE, 'needs your review')
    }
  } else if (item.source === 'calendar') {
    scoreCalendar(item, ctx, add)
  }

  const createdAt = ms(item.createdAt)
  if (createdAt !== null) {
    const days = Math.floor((now - createdAt) / DAY_MS)
    if (days >= 1) {
      score += Math.min(days, AGE_MAX_DAYS)
      if (days >= AGE_REASON_MIN_DAYS) reasons.push(`waiting ${days}d`)
    }
  }

  if (item.status === 'snoozed' && !isSnoozeActive(item, now)) {
    add(BACK_FROM_SNOOZE_SCORE, 'back from snooze')
  }

  return { score, reasons }
}

/**
 * Section for one item. `nowRank` is the item's 0-based position among the
 * unresolved items of the ranked list (null when the item cannot be in `now`).
 */
export function sectionFor(
  item: PlannerItemDTO,
  score: number,
  ctx: RankContext,
  nowRank: number | null
): PlannerSection {
  if (item.status === 'done') return 'done'
  if (item.status === 'dismissed') return 'dismissed'
  if (item.status === 'wont_do') return 'wont_do'

  const now = ctx.now.getTime()
  if (isSnoozeActive(item, now)) return 'snoozed'

  const windowStart = ctx.window.start.getTime()
  const windowEnd = ctx.window.end.getTime()
  const dueAt = ms(item.dueAt)
  const startsAt = ms(item.startsAt)
  const endsAt = ms(item.endsAt)
  // An ended meeting is normally resolved by the collector; until it is, it is
  // never `now` or `today` (§4.3).
  const ended = item.source === 'calendar' && endsAt !== null && endsAt <= now

  if (!ended) {
    if (nowRank !== null && nowRank < NOW_MAX_ITEMS && score >= NOW_MIN_SCORE) return 'now'
    if (score >= TODAY_MIN_SCORE) return 'today'
    if (dueAt !== null && dueAt >= windowStart && dueAt < windowEnd) return 'today'
    if (
      item.source === 'calendar' &&
      startsAt !== null &&
      endsAt !== null &&
      startsAt < windowEnd &&
      endsAt > windowStart
    ) {
      return 'today'
    }
  }

  if (dueAt !== null && dueAt < windowEnd + SOON_DAYS * DAY_MS) return 'soon'
  if (score >= SOON_MIN_SCORE) return 'soon'
  return 'later'
}

function compareTimes(a: string | null, b: string | null): number {
  const ta = ms(a)
  const tb = ms(b)
  if (ta === tb) return 0
  if (ta === null) return 1 // nulls last
  if (tb === null) return -1
  return ta - tb
}

/**
 * Scores, sorts and sections every item. Stable, total, and free of side
 * effects: the input array and its items are never mutated.
 */
export function rankItems(items: PlannerItemDTO[], ctx: RankContext): RankedItemDTO[] {
  const now = ctx.now.getTime()
  const scored = items.map((item) => ({ item, ...scoreItem(item, ctx) }))

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const due = compareTimes(a.item.dueAt, b.item.dueAt)
    if (due !== 0) return due
    const starts = compareTimes(a.item.startsAt, b.item.startsAt)
    if (starts !== 0) return starts
    const created = compareTimes(a.item.createdAt, b.item.createdAt)
    if (created !== 0) return created
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0
  })

  let rank = 0
  return scored.map(({ item, score, reasons }) => {
    const rankable = !isResolved(item.status) && !isSnoozeActive(item, now)
    const nowRank = rankable ? rank++ : null
    return { ...item, score, reasons, section: sectionFor(item, score, ctx, nowRank) }
  })
}
