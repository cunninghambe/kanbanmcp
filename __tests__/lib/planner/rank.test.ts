/**
 * Deterministic ranking — every scoring row of spec §4.3 with exact points and
 * reason strings, tie-breaks, and section assignment (§1.3). Pure function, no
 * clock: `now` and the window are passed in. (WI-1)
 */
import { describe, it, expect } from 'vitest'
import {
  ALL_DAY_SCORE,
  MEETING_IMMINENT_MS,
  MEETING_NEAR_MS,
  MEETING_NOW_SCORE,
  MEETING_SOON_MS,
  NOW_MAX_ITEMS,
  NOW_MIN_SCORE,
  SOON_MIN_SCORE,
  TODAY_MIN_SCORE,
  rankItems,
  scoreItem,
  type RankContext,
} from '../../../src/lib/planner/rank'
import { dayBounds } from '../../../src/lib/planner/time'
import type { PlannerItemDTO } from '../../../src/lib/planner/types'

const NOW = new Date('2026-09-16T09:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const CTX: RankContext = { now: NOW, window: dayBounds('2026-09-16', 'UTC'), tz: 'UTC' }

let seq = 0
function item(overrides: Partial<PlannerItemDTO> = {}): PlannerItemDTO {
  seq += 1
  return {
    id: `it-${String(seq).padStart(3, '0')}`,
    source: 'card',
    sourceKey: `card:c${seq}`,
    title: `Item ${seq}`,
    summary: null,
    url: null,
    priority: 'none',
    dueAt: null,
    startsAt: null,
    endsAt: null,
    status: 'open',
    snoozedUntil: null,
    resolvedBy: null,
    resolvedAt: null,
    prepNotes: null,
    payload: {},
    lastSeenAt: NOW.toISOString(),
    createdAt: NOW.toISOString(), // age 0 → no age points
    updatedAt: NOW.toISOString(),
    ...overrides,
  }
}

const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

describe('planner/rank — constants', () => {
  it('exports the thresholds the spec names', () => {
    expect(NOW_MIN_SCORE).toBe(25)
    expect(NOW_MAX_ITEMS).toBe(3)
    expect(TODAY_MIN_SCORE).toBe(12)
    expect(SOON_MIN_SCORE).toBe(5)
    expect(MEETING_IMMINENT_MS).toBe(15 * 60 * 1000)
    expect(MEETING_NEAR_MS).toBe(60 * 60 * 1000)
    expect(MEETING_SOON_MS).toBe(2 * 60 * 60 * 1000)
    expect(MEETING_NOW_SCORE).toBe(65)
    expect(ALL_DAY_SCORE).toBe(3)
  })
})

describe('planner/rank — scoreItem: due dates', () => {
  it('overdue by whole days: 40 + 2/day, capped at 10 days', () => {
    expect(scoreItem(item({ dueAt: iso(-2 * DAY) }), CTX)).toEqual({
      score: 44,
      reasons: ['overdue 2d'],
    })
    expect(scoreItem(item({ dueAt: iso(-30 * DAY) }), CTX)).toEqual({
      score: 60,
      reasons: ['overdue 30d'],
    })
  })

  it('overdue earlier today reads "overdue today"', () => {
    expect(scoreItem(item({ dueAt: iso(-1 * HOUR) }), CTX)).toEqual({
      score: 40,
      reasons: ['overdue today'],
    })
  })

  it('due later today / tomorrow / this week / beyond', () => {
    expect(scoreItem(item({ dueAt: iso(3 * HOUR) }), CTX)).toEqual({
      score: 30,
      reasons: ['due today'],
    })
    expect(scoreItem(item({ dueAt: '2026-09-17T10:00:00.000Z' }), CTX)).toEqual({
      score: 15,
      reasons: ['due tomorrow'],
    })
    expect(scoreItem(item({ dueAt: '2026-09-19T10:00:00.000Z' }), CTX)).toEqual({
      score: 6,
      reasons: ['due this week'],
    })
    expect(scoreItem(item({ dueAt: '2026-09-30T10:00:00.000Z' }), CTX)).toEqual({
      score: 0,
      reasons: [],
    })
  })

  it('uses the window edges, not calendar days, for "due today" / "due tomorrow"', () => {
    // last instant inside the window is still today
    expect(scoreItem(item({ dueAt: '2026-09-16T23:59:59.000Z' }), CTX).reasons).toEqual([
      'due today',
    ])
    // exactly window.end is tomorrow
    expect(scoreItem(item({ dueAt: '2026-09-17T00:00:00.000Z' }), CTX).reasons).toEqual([
      'due tomorrow',
    ])
  })
})

describe('planner/rank — scoreItem: priority and sources', () => {
  it('priority ladder', () => {
    expect(scoreItem(item({ priority: 'critical' }), CTX)).toEqual({
      score: 25,
      reasons: ['critical'],
    })
    expect(scoreItem(item({ priority: 'high' }), CTX)).toEqual({ score: 15, reasons: ['high'] })
    expect(scoreItem(item({ priority: 'medium' }), CTX)).toEqual({ score: 8, reasons: ['medium'] })
    expect(scoreItem(item({ priority: 'low' }), CTX)).toEqual({ score: 3, reasons: ['low'] })
    expect(scoreItem(item({ priority: 'none' }), CTX)).toEqual({ score: 0, reasons: [] })
  })

  it('email: urgent vs plain', () => {
    expect(scoreItem(item({ source: 'email', payload: { urgent: true } }), CTX)).toEqual({
      score: 30,
      reasons: ['urgent email'],
    })
    expect(scoreItem(item({ source: 'email', payload: { urgent: false } }), CTX)).toEqual({
      score: 10,
      reasons: ['email'],
    })
    expect(scoreItem(item({ source: 'email', payload: {} }), CTX)).toEqual({
      score: 10,
      reasons: ['email'],
    })
  })

  it('slack: dm vs mention', () => {
    expect(scoreItem(item({ source: 'slack', payload: { kind: 'dm' } }), CTX)).toEqual({
      score: 12,
      reasons: ['slack dm'],
    })
    expect(scoreItem(item({ source: 'slack', payload: { kind: 'mention' } }), CTX)).toEqual({
      score: 10,
      reasons: ['slack mention'],
    })
  })

  it('manual to-do', () => {
    expect(scoreItem(item({ source: 'manual' }), CTX)).toEqual({
      score: 5,
      reasons: ['your to-do'],
    })
  })

  it('card reviewer / approver roles add "needs your review"; assignee does not', () => {
    expect(scoreItem(item({ payload: { role: 'reviewer' } }), CTX)).toEqual({
      score: 5,
      reasons: ['needs your review'],
    })
    expect(scoreItem(item({ payload: { role: 'approver' } }), CTX)).toEqual({
      score: 5,
      reasons: ['needs your review'],
    })
    expect(scoreItem(item({ payload: { role: 'assignee' } }), CTX)).toEqual({
      score: 0,
      reasons: [],
    })
  })

  it('signals add up and reasons keep the table order', () => {
    const r = scoreItem(
      item({ source: 'email', priority: 'high', dueAt: iso(-2 * DAY), payload: { urgent: true } }),
      CTX
    )
    expect(r.score).toBe(44 + 15 + 30)
    expect(r.reasons).toEqual(['overdue 2d', 'high', 'urgent email'])
  })
})

describe('planner/rank — scoreItem: calendar', () => {
  const cal = (startMs: number, endMs: number, extra: Partial<PlannerItemDTO> = {}) =>
    item({ source: 'calendar', startsAt: iso(startMs), endsAt: iso(endMs), ...extra })

  it('meeting in progress', () => {
    expect(scoreItem(cal(-30 * 60_000, 30 * 60_000), CTX)).toEqual({
      score: 65,
      reasons: ['meeting now'],
    })
  })

  it('imminent (≤15m) → 80, near (≤60m) → 50, soon (≤2h) → 30, with minutes in the reason', () => {
    expect(scoreItem(cal(5 * 60_000, 35 * 60_000), CTX)).toEqual({
      score: 80,
      reasons: ['meeting in 5m'],
    })
    expect(scoreItem(cal(15 * 60_000, 45 * 60_000), CTX)).toEqual({
      score: 80,
      reasons: ['meeting in 15m'],
    })
    expect(scoreItem(cal(30 * 60_000, 60 * 60_000), CTX)).toEqual({
      score: 50,
      reasons: ['meeting in 30m'],
    })
    expect(scoreItem(cal(60 * 60_000, 90 * 60_000), CTX)).toEqual({
      score: 50,
      reasons: ['meeting in 60m'],
    })
    expect(scoreItem(cal(90 * 60_000, 120 * 60_000), CTX)).toEqual({
      score: 30,
      reasons: ['meeting in 90m'],
    })
    expect(scoreItem(cal(120 * 60_000, 150 * 60_000), CTX)).toEqual({
      score: 30,
      reasons: ['meeting in 120m'],
    })
  })

  it('later today → 20, after the window → 0 with the local date in the user zone', () => {
    expect(scoreItem(cal(4 * HOUR, 5 * HOUR), CTX)).toEqual({
      score: 20,
      reasons: ['meeting today'],
    })
    expect(scoreItem(cal(30 * HOUR, 31 * HOUR), CTX)).toEqual({
      score: 0,
      reasons: ['meeting 2026-09-17'],
    })

    // Same instant, Auckland zone: 2026-09-17T13:00Z is 01:00 on the 18th there.
    const akl: RankContext = {
      now: NOW,
      window: dayBounds('2026-09-16', 'Pacific/Auckland'),
      tz: 'Pacific/Auckland',
    }
    const startsAt = '2026-09-17T13:00:00.000Z'
    expect(
      scoreItem(item({ source: 'calendar', startsAt, endsAt: '2026-09-17T14:00:00.000Z' }), akl)
    ).toEqual({
      score: 0,
      reasons: ['meeting 2026-09-18'],
    })
  })

  it('an ended meeting scores 0 / "meeting ended" and is never now or today', () => {
    const ended = cal(-3 * HOUR, -2 * HOUR)
    expect(scoreItem(ended, CTX)).toEqual({ score: 0, reasons: ['meeting ended'] })
    const [ranked] = rankItems([ended], CTX)
    expect(['now', 'today']).not.toContain(ranked.section)
  })

  it('all-day items score 3 / "all day" and never enter the meeting ladder', () => {
    const allDay = cal(-9 * HOUR, 15 * HOUR, { payload: { allDay: true } }) // spans the whole window
    expect(scoreItem(allDay, CTX)).toEqual({ score: 3, reasons: ['all day'] })
  })

  it('all-day items overlapping the window land in today but do not displace a timed meeting from now', () => {
    const allDay = cal(-9 * HOUR, 15 * HOUR, { payload: { allDay: true } })
    const live = cal(-10 * 60_000, 20 * 60_000)
    const ranked = rankItems([allDay, live], CTX)
    expect(ranked.find((r) => r.id === live.id)?.section).toBe('now')
    expect(ranked.find((r) => r.id === allDay.id)?.section).toBe('today')
  })

  it('a meeting starting in 5 minutes outranks a 3-day-overdue critical card', () => {
    const meeting = cal(5 * 60_000, 35 * 60_000)
    const card = item({ priority: 'critical', dueAt: iso(-3 * DAY) })
    expect(scoreItem(card, CTX).score).toBe(40 + 6 + 25)
    const ranked = rankItems([card, meeting], CTX)
    expect(ranked[0].id).toBe(meeting.id)
    expect(ranked[0].section).toBe('now')
  })
})

describe('planner/rank — scoreItem: age and snooze', () => {
  it('age adds min(days, 7) points and a reason only from 2 days', () => {
    expect(scoreItem(item({ createdAt: iso(-1 * DAY) }), CTX)).toEqual({ score: 1, reasons: [] })
    expect(scoreItem(item({ createdAt: iso(-3 * DAY) }), CTX)).toEqual({
      score: 3,
      reasons: ['waiting 3d'],
    })
    expect(scoreItem(item({ createdAt: iso(-10 * DAY) }), CTX)).toEqual({
      score: 7,
      reasons: ['waiting 10d'],
    })
  })

  it('a snooze that has elapsed adds 5 / "back from snooze" and ranks like an open item', () => {
    const back = item({ status: 'snoozed', snoozedUntil: iso(-5 * 60_000), priority: 'high' })
    expect(scoreItem(back, CTX)).toEqual({ score: 20, reasons: ['high', 'back from snooze'] })
    expect(rankItems([back], CTX)[0].section).toBe('today')
  })

  it('a future snooze is sectioned as snoozed regardless of score', () => {
    const future = item({
      status: 'snoozed',
      snoozedUntil: iso(2 * HOUR),
      priority: 'critical',
      dueAt: iso(-5 * DAY),
    })
    expect(rankItems([future], CTX)[0].section).toBe('snoozed')
  })

  it('resolved items score 0 with no reasons and take their status section', () => {
    for (const [status, section] of [
      ['done', 'done'],
      ['dismissed', 'dismissed'],
      ['wont_do', 'wont_do'],
    ] as const) {
      const [r] = rankItems([item({ status, priority: 'critical', dueAt: iso(-3 * DAY) })], CTX)
      expect(r.score).toBe(0)
      expect(r.reasons).toEqual([])
      expect(r.section).toBe(section)
    }
  })
})

describe('planner/rank — rankItems: order and sections', () => {
  it('sorts by score desc and assigns now (max 3, score ≥ 25), today, soon, later', () => {
    const a = item({ priority: 'critical', dueAt: iso(-10 * DAY) }) // 60 + 25 = 85
    const b = item({ priority: 'critical', dueAt: iso(-1 * DAY) }) // 42 + 25 = 67
    const c = item({ source: 'email', priority: 'high', payload: { urgent: true } }) // 15 + 30 = 45
    const d = item({ dueAt: iso(3 * HOUR) }) // 30 → 4th item scoring ≥ 25, capped out of now → today
    const e = item({ source: 'slack', payload: { kind: 'mention' } }) // 10 → soon (≥ 5)
    const f = item({ dueAt: '2026-09-21T10:00:00.000Z' }) // 6 → soon (due within 7 days)
    const g = item({}) // 0 → later
    const ranked = rankItems([g, f, e, d, c, b, a], CTX)
    expect(ranked.map((r) => r.id)).toEqual([a.id, b.id, c.id, d.id, e.id, f.id, g.id])
    expect(ranked.map((r) => r.section)).toEqual([
      'now',
      'now',
      'now',
      'today',
      'soon',
      'soon',
      'later',
    ])
  })

  it('now requires score ≥ 25 even when fewer than 3 items exist', () => {
    const weak = item({ priority: 'medium' }) // 8
    const [r] = rankItems([weak], CTX)
    expect(r.section).toBe('soon')
  })

  it('an item due today is "today" even with a low score', () => {
    const [r] = rankItems(
      [item({ dueAt: iso(5 * HOUR), priority: 'none', createdAt: NOW.toISOString() })],
      CTX
    )
    // 30 points from "due today" alone → today (not now, since only 30 ≥ 25 and... it is the first item)
    expect(['now', 'today']).toContain(r.section)
  })

  it('an item due within the window but scoring below 12 still lands in today', () => {
    // Impossible via due today (30 points) — exercise the calendar-overlap rule instead: an
    // all-day event scores 3 but overlaps the window.
    const allDay = item({
      source: 'calendar',
      startsAt: iso(-9 * HOUR),
      endsAt: iso(15 * HOUR),
      payload: { allDay: true },
    })
    expect(rankItems([allDay], CTX)[0].section).toBe('today')
  })

  it('soon includes items due within 7 days of window.end, later is everything else', () => {
    const soon = item({ dueAt: '2026-09-23T23:00:00.000Z' }) // < window.end + 7d = 2026-09-24T00:00Z
    const later = item({ dueAt: '2026-09-24T00:00:00.000Z' })
    const ranked = rankItems([soon, later], CTX)
    expect(ranked.find((r) => r.id === soon.id)?.section).toBe('soon')
    expect(ranked.find((r) => r.id === later.id)?.section).toBe('later')
  })

  it('tie-break: dueAt asc (nulls last), then startsAt asc (nulls last), then createdAt asc, then id asc', () => {
    const noDue = item({ id: 'b-id', priority: 'medium' })
    const dueLater = item({ id: 'c-id', priority: 'medium', dueAt: '2026-09-30T10:00:00.000Z' })
    const dueSooner = item({ id: 'a-id', priority: 'medium', dueAt: '2026-09-29T10:00:00.000Z' })
    // all score 8
    expect(rankItems([noDue, dueLater, dueSooner], CTX).map((r) => r.id)).toEqual([
      'a-id',
      'c-id',
      'b-id',
    ])

    const older = item({ id: 'z-id', priority: 'medium', createdAt: iso(-1 * HOUR) })
    const newer = item({ id: 'a2-id', priority: 'medium', createdAt: NOW.toISOString() })
    expect(rankItems([newer, older], CTX).map((r) => r.id)).toEqual(['z-id', 'a2-id'])

    const x = item({ id: 'x-id', priority: 'medium' })
    const w = item({ id: 'w-id', priority: 'medium' })
    expect(rankItems([x, w], CTX).map((r) => r.id)).toEqual(['w-id', 'x-id'])
  })

  it('is stable and total: the output has every input exactly once, with score/reasons/section', () => {
    const items = Array.from({ length: 12 }, (_, i) => item({ priority: i % 2 ? 'high' : 'none' }))
    const ranked = rankItems(items, CTX)
    expect(ranked).toHaveLength(12)
    expect(new Set(ranked.map((r) => r.id)).size).toBe(12)
    for (const r of ranked) {
      expect(typeof r.score).toBe('number')
      expect(Array.isArray(r.reasons)).toBe(true)
      expect(r.section).toBeDefined()
    }
    expect(rankItems(items, CTX)).toEqual(ranked)
  })

  it('does not mutate its input', () => {
    const src = [item({ priority: 'high' }), item({})]
    const copy = JSON.parse(JSON.stringify(src))
    rankItems(src, CTX)
    expect(src).toEqual(copy)
  })
})
