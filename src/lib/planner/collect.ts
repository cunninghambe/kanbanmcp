// The per-user collector.
// Spec: docs/specs/mhud-today-planner.md §4.4.
//
// The four source readers are independent and are run with Promise.allSettled,
// so one failing source never costs another its items. Writes then happen one
// source at a time: the items first (upsert by the (userId, sourceKey) compound
// key, never touching a user decision), then that source's resolution pass. A
// source that errored or was skipped writes nothing at all.

import { InsufficientScopesError } from '@/lib/google/errors'
import type { Prisma } from '@prisma/client'
import { COLLECTED_SOURCES, safeItemUrl } from './types'
import type {
  CollectResult,
  CollectedSource,
  DayWindow,
  SourceContext,
  SourceItem,
  SourceRead,
  SourceReader,
  SourceStatus,
} from './types'

/** The slice of the Prisma client the collector writes through. */
export interface CollectPrisma {
  plannerItem: {
    upsert(args: Prisma.PlannerItemUpsertArgs): Promise<unknown>
    updateMany(args: Prisma.PlannerItemUpdateManyArgs): Promise<{ count: number }>
  }
}

export interface CollectDeps {
  prisma: CollectPrisma
  readers: Record<CollectedSource, SourceReader>
  /** For tests. Defaults to () => new Date(). */
  now?: () => Date
}

const ERROR_MAX_CHARS = 500

function errorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.slice(0, ERROR_MAX_CHARS)
}

function isDayWindow(value: SourceRead['resolveMissing']): value is DayWindow {
  return typeof value !== 'string'
}

/**
 * The `where` of the absence-resolution pass for one source, or null when this
 * read claims no authority over what it did not report.
 */
function resolutionWhere(
  source: CollectedSource,
  resolveMissing: SourceRead['resolveMissing'],
  userId: string,
  runStartedAt: Date
): Prisma.PlannerItemWhereInput | null {
  if (resolveMissing === 'none') return null
  const base = { userId, source, lastSeenAt: { lt: runStartedAt } }
  if (resolveMissing === 'open') return { ...base, status: 'open' }
  const openOrSnoozed = { ...base, status: { in: ['open', 'snoozed'] } }
  if (resolveMissing === 'all') return openOrSnoozed
  if (isDayWindow(resolveMissing)) {
    return {
      ...openOrSnoozed,
      startsAt: { gte: resolveMissing.start, lt: resolveMissing.end },
    }
  }
  return null
}

function upsertArgs(
  item: SourceItem,
  source: CollectedSource,
  ctx: SourceContext,
  runStartedAt: Date
): Prisma.PlannerItemUpsertArgs {
  const fields = {
    title: item.title,
    summary: item.summary ?? null,
    url: safeItemUrl(item.url) ?? null,
    priority: item.priority ?? 'none',
    dueAt: item.dueAt ?? null,
    startsAt: item.startsAt ?? null,
    endsAt: item.endsAt ?? null,
    payload: JSON.stringify(item.payload ?? {}),
    lastSeenAt: runStartedAt,
  }
  return {
    where: { userId_sourceKey: { userId: ctx.userId, sourceKey: item.sourceKey } },
    create: {
      orgId: ctx.orgId,
      userId: ctx.userId,
      source,
      sourceKey: item.sourceKey,
      status: 'open',
      ...fields,
    },
    // Never `status`, `snoozedUntil`, `resolved*` or `prepNotes`: user
    // decisions and attended output are sticky (§1.2).
    update: { ...fields },
  }
}

/**
 * Collects every configured source for one user and writes the result.
 * Never throws for a reader failure — only Prisma itself can throw out of here.
 */
export async function collectForUser(
  ctx: SourceContext,
  deps: CollectDeps
): Promise<CollectResult> {
  const clock = deps.now ?? (() => new Date())
  const runStartedAt = clock()

  const settled = await Promise.allSettled(
    COLLECTED_SOURCES.map((source) => deps.readers[source](ctx))
  )

  const status = {} as Record<CollectedSource, SourceStatus>
  const errors: Partial<Record<CollectedSource, string>> = {}
  let upserted = 0
  let resolved = 0
  let calendarRead = false

  for (let i = 0; i < COLLECTED_SOURCES.length; i += 1) {
    const source = COLLECTED_SOURCES[i]
    const outcome = settled[i]

    if (outcome.status === 'rejected') {
      status[source] = outcome.reason instanceof InsufficientScopesError ? 'needs_scope' : 'error'
      errors[source] = errorMessage(outcome.reason)
      continue
    }

    const read = outcome.value
    if (!read) {
      status[source] = 'skipped'
      continue
    }

    for (const item of read.items) {
      // Defensive: a reader must key its items with its own prefix.
      if (!item.sourceKey.startsWith(`${source}:`)) continue
      await deps.prisma.plannerItem.upsert(upsertArgs(item, source, ctx, runStartedAt))
      upserted += 1
    }

    const where = resolutionWhere(source, read.resolveMissing, ctx.userId, runStartedAt)
    if (where) {
      const result = await deps.prisma.plannerItem.updateMany({
        where,
        data: { status: 'done', resolvedBy: 'source', resolvedAt: runStartedAt },
      })
      resolved += result.count
    }

    status[source] = 'ok'
    if (source === 'calendar') calendarRead = true
  }

  // A meeting that has ended is done, whether or not the calendar still lists
  // it — but only when the calendar was actually read this run (§4.4 step 3).
  if (calendarRead) {
    await deps.prisma.plannerItem.updateMany({
      where: {
        userId: ctx.userId,
        source: 'calendar',
        status: { in: ['open', 'snoozed'] },
        endsAt: { lt: runStartedAt },
      },
      data: { status: 'done', resolvedBy: 'elapsed', resolvedAt: runStartedAt },
    })
  }

  return { upserted, resolved, status, errors }
}
