// What the planner routes call (spec §4.12).
//
// The collector is only ever triggered by a logged-in page load, and it is
// serialised per user with `withKeyedLock` so two tabs cannot interleave their
// upserts. The today read is deliberately two capped queries: a long resolved
// backlog must never crowd the open work out of the payload.

import type { PlannerDay, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { withKeyedLock } from '@/lib/keyed-mutex'
import type { SessionData } from '@/lib/session'
import { collectForUser } from './collect'
import { rankItems } from './rank'
import { defaultReaders } from './sources/index'
import { DATE_RE, dayBounds, isValidTimeZone } from './time'
import { COLLECTED_SOURCES, parseJsonObject, toPlannerItemDTO } from './types'
import type {
  CollectResult,
  CollectedSource,
  PlannerAction,
  PlannerItemDTO,
  RankedItemDTO,
  SourceReader,
  SourceStatus,
  TodayCounts,
  TodayResponse,
} from './types'
import { applyWriteThrough } from './write-through'
import type { WriteThroughResult } from './types'

export const COLLECT_STALE_MS_DEFAULT = 5 * 60_000
const COLLECT_STALE_MS_MIN = 10_000
const OPEN_ITEMS_CAP = 500
const RESOLVED_ITEMS_CAP = 200

const SOURCE_STATUSES: ReadonlySet<string> = new Set(['ok', 'error', 'skipped', 'needs_scope'])

/** `YYYY-MM-DD` that is also a real calendar date. */
export const plannerDateSchema = z
  .string()
  .regex(DATE_RE, 'date must be YYYY-MM-DD')
  .refine((date) => {
    const [y, m, d] = date.split('-').map(Number)
    const probe = new Date(Date.UTC(y, m - 1, d))
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  }, 'date is not a real calendar date')

export const plannerTzSchema = z.string().refine(isValidTimeZone, 'tz must be an IANA time zone')

export function collectStaleMs(): number {
  const raw = Number(process.env.PLANNER_COLLECT_STALE_MS)
  if (!Number.isFinite(raw) || raw <= 0) return COLLECT_STALE_MS_DEFAULT
  return Math.max(raw, COLLECT_STALE_MS_MIN)
}

export async function getOrCreateDay(
  prisma: PrismaClient,
  args: { userId: string; orgId: string; date: string; tz: string }
): Promise<PlannerDay> {
  return prisma.plannerDay.upsert({
    where: { userId_date: { userId: args.userId, date: args.date } },
    create: { orgId: args.orgId, userId: args.userId, date: args.date, tz: args.tz },
    update: {},
  })
}

export interface EnsureCollectedResult {
  collected: boolean
  result: CollectResult | null
  day: PlannerDay
}

/**
 * Collects when forced or when the last collection is older than
 * `PLANNER_COLLECT_STALE_MS`, then persists the outcome on the day row.
 */
export async function ensureCollected(
  prisma: PrismaClient,
  args: {
    userId: string
    orgId: string
    date: string
    tz: string
    force: boolean
    now?: Date
    readers?: Record<CollectedSource, SourceReader>
  }
): Promise<EnsureCollectedResult> {
  const { userId, orgId, date, tz, force } = args
  const now = args.now ?? new Date()
  const day = await getOrCreateDay(prisma, { userId, orgId, date, tz })

  const age = day.lastCollectedAt ? now.getTime() - day.lastCollectedAt.getTime() : Infinity
  if (!force && age < collectStaleMs()) return { collected: false, result: null, day }

  return withKeyedLock(`planner:${userId}`, async () => {
    const result = await collectForUser(
      { userId, orgId, tz, now, window: dayBounds(date, tz) },
      { prisma, readers: args.readers ?? defaultReaders() }
    )
    const updated = await prisma.plannerDay.update({
      where: { id: day.id },
      data: {
        lastCollectedAt: now,
        collectStatus: JSON.stringify({ ...result.status, errors: result.errors }),
      },
    })
    return { collected: true, result, day: updated }
  })
}

function readCollectStatus(day: PlannerDay): {
  sources: Record<CollectedSource, SourceStatus>
  sourceErrors: Partial<Record<CollectedSource, string>>
} {
  const parsed = parseJsonObject(day.collectStatus)
  const rawErrors = parsed.errors
  const errorsObject =
    rawErrors && typeof rawErrors === 'object' && !Array.isArray(rawErrors)
      ? (rawErrors as Record<string, unknown>)
      : {}

  const sources = {} as Record<CollectedSource, SourceStatus>
  const sourceErrors: Partial<Record<CollectedSource, string>> = {}
  for (const source of COLLECTED_SOURCES) {
    const value = parsed[source]
    sources[source] =
      typeof value === 'string' && SOURCE_STATUSES.has(value) ? (value as SourceStatus) : 'skipped'
    const message = errorsObject[source]
    if (typeof message === 'string' && message) sourceErrors[source] = message
  }
  return { sources, sourceErrors }
}

function countFor(
  items: RankedItemDTO[],
  window: { start: Date; end: Date },
  now: Date
): TodayCounts {
  const isOpen = (i: RankedItemDTO) => i.status === 'open'
  const meeting = (i: RankedItemDTO) => {
    if (i.source !== 'calendar' || i.payload.allDay === true) return false
    if (!i.startsAt || !i.endsAt) return false
    return (
      new Date(i.startsAt).getTime() < window.end.getTime() &&
      new Date(i.endsAt).getTime() > window.start.getTime()
    )
  }
  return {
    now: items.filter((i) => i.section === 'now').length,
    open: items.filter(isOpen).length,
    overdue: items.filter((i) => isOpen(i) && i.dueAt !== null && new Date(i.dueAt) < now).length,
    meetingsToday: items.filter(meeting).length,
    inbox: items.filter((i) => isOpen(i) && i.source === 'email').length,
    slack: items.filter((i) => isOpen(i) && i.source === 'slack').length,
    doneToday: items.filter((i) => i.status === 'done').length,
    dismissed: items.filter((i) => i.status === 'dismissed').length,
  }
}

/** Loads, ranks and counts one day. Pure read — it never collects. */
export async function buildTodayResponse(
  prisma: PrismaClient,
  args: {
    userId: string
    orgId: string
    date: string
    tz: string
    now?: Date
    /** The day row the caller already has (from `ensureCollected`). */
    day?: PlannerDay
  }
): Promise<TodayResponse> {
  const { userId, orgId, date, tz } = args
  const now = args.now ?? new Date()
  const window = dayBounds(date, tz)
  const day = args.day ?? (await getOrCreateDay(prisma, { userId, orgId, date, tz }))

  const openRows = await prisma.plannerItem.findMany({
    where: { userId, orgId, status: { in: ['open', 'snoozed'] } },
    orderBy: { createdAt: 'desc' },
    take: OPEN_ITEMS_CAP,
  })
  const resolvedRows = await prisma.plannerItem.findMany({
    where: {
      userId,
      orgId,
      status: { in: ['done', 'dismissed', 'wont_do'] },
      resolvedAt: { gte: window.start },
    },
    orderBy: { resolvedAt: 'desc' },
    take: RESOLVED_ITEMS_CAP,
  })

  const items = rankItems([...openRows, ...resolvedRows].map(toPlannerItemDTO), {
    now,
    window,
    tz,
  })
  const { sources, sourceErrors } = readCollectStatus(day)

  return {
    date,
    tz,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    collectedAt: day.lastCollectedAt ? day.lastCollectedAt.toISOString() : null,
    sources,
    sourceErrors,
    brief:
      day.brief && day.briefAt
        ? { text: day.brief, model: day.briefModel ?? null, at: day.briefAt.toISOString() }
        : null,
    items,
    truncated: openRows.length >= OPEN_ITEMS_CAP || resolvedRows.length >= RESOLVED_ITEMS_CAP,
    counts: countFor(items, window, now),
  }
}

function dataForAction(
  action: PlannerAction,
  now: Date,
  snoozedUntil?: Date
): Record<string, unknown> {
  switch (action) {
    case 'done':
      return { status: 'done', resolvedBy: 'user', resolvedAt: now, snoozedUntil: null }
    case 'dismiss':
      return { status: 'dismissed', resolvedBy: 'user', resolvedAt: now, snoozedUntil: null }
    case 'wont_do':
      return { status: 'wont_do', resolvedBy: 'user', resolvedAt: now, snoozedUntil: null }
    case 'snooze':
      return { status: 'snoozed', snoozedUntil, resolvedBy: null, resolvedAt: null }
    case 'reopen':
      return { status: 'open', snoozedUntil: null, resolvedBy: null, resolvedAt: null }
  }
}

/**
 * Applies a user action to one of the caller's items, then runs the
 * write-through. `null` means "not this user's item" — the route answers 404.
 */
export async function applyItemAction(
  prisma: PrismaClient,
  args: {
    session: SessionData
    itemId: string
    action: PlannerAction
    snoozedUntil?: Date
    writeThrough: boolean
    now?: Date
  }
): Promise<{ item: PlannerItemDTO; writeThrough: WriteThroughResult[] } | null> {
  const { session, itemId, action } = args
  const now = args.now ?? new Date()

  const existing = await prisma.plannerItem.findFirst({
    where: { id: itemId, userId: session.userId, orgId: session.orgId },
  })
  if (!existing) return null

  const updated = await prisma.plannerItem.update({
    where: { id: itemId },
    data: dataForAction(action, now, args.snoozedUntil),
  })
  const item = toPlannerItemDTO(updated)

  // The status change is already persisted: a write-through failure is reported,
  // never fatal (§4.10).
  const writeThrough = args.writeThrough
    ? await applyWriteThrough({ prisma, item, action, session })
    : []

  return { item, writeThrough }
}
