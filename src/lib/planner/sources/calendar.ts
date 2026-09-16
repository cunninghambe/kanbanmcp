// Calendar source for the Today planner (spec §4.5).
// Reads a 7-day window from the primary Google calendar and maps it to planner
// items. All-day events are re-derived into the user's local days here: the UTC
// instants google/calendar.ts carries for them are informational only.

import { prisma } from '@/lib/db'
import { listEvents, type CalendarEvent } from '@/lib/google/calendar'
import { addDays, dayBounds } from '@/lib/planner/time'
import type { SourceContext, SourceItem, SourceRead } from '@/lib/planner/types'

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_DAYS = 7
const MAX_SUMMARY_ATTENDEES = 6
const MAX_DESCRIPTION_CHARS = 2000

interface PayloadAttendee {
  email: string
  name?: string
  responseStatus?: string
  self: boolean
}

function toPayloadAttendee(attendee: CalendarEvent['attendees'][number]): PayloadAttendee {
  return {
    email: attendee.email,
    name: attendee.name,
    responseStatus: attendee.responseStatus,
    self: attendee.self ?? false,
  }
}

/** Attendee display names (falling back to the address), capped with a `+N` tail. */
function attendeeSummary(attendees: PayloadAttendee[]): string | null {
  if (attendees.length === 0) return null
  const names = attendees.map((a) => a.name ?? a.email)
  const shown = names.slice(0, MAX_SUMMARY_ATTENDEES).join(', ')
  const rest = names.length - MAX_SUMMARY_ATTENDEES
  return rest > 0 ? `${shown} +${rest}` : shown
}

/** The user declined it, it was cancelled, or it is marked free — not planner work. */
function isSkippable(event: CalendarEvent): boolean {
  if (event.status === 'cancelled') return true
  if (event.transparency === 'transparent') return true
  return event.attendees.some((a) => a.self === true && a.responseStatus === 'declined')
}

/**
 * All-day events belong to their own local days in `ctx.tz`. Google's `end.date`
 * is exclusive, so a one-day event ends on its start day and a multi-day one
 * runs to the end of the day before `endDate`.
 */
function localBounds(event: CalendarEvent, tz: string): { startsAt: Date; endsAt: Date } {
  if (!event.allDay || !event.startDate || !event.endDate) {
    return { startsAt: event.start, endsAt: event.end }
  }
  try {
    const lastDate = addDays(event.endDate, -1)
    const endDate = lastDate < event.startDate ? event.startDate : lastDate
    return { startsAt: dayBounds(event.startDate, tz).start, endsAt: dayBounds(endDate, tz).end }
  } catch {
    // Malformed date strings: fall back to the instants Google gave us.
    return { startsAt: event.start, endsAt: event.end }
  }
}

function toItem(event: CalendarEvent, tz: string): SourceItem {
  const attendees = event.attendees.map(toPayloadAttendee)
  const { startsAt, endsAt } = localBounds(event, tz)

  return {
    sourceKey: `calendar:${event.id}`,
    title: event.summary ?? '(no title)',
    summary: attendeeSummary(attendees),
    url: event.htmlLink,
    startsAt,
    endsAt,
    payload: {
      eventId: event.id,
      attendees,
      organizer: event.organizer,
      location: event.location,
      hangoutLink: event.hangoutLink,
      description: event.description?.slice(0, MAX_DESCRIPTION_CHARS) ?? null,
      allDay: event.allDay,
    },
  }
}

export async function readCalendar(ctx: SourceContext): Promise<SourceRead | null> {
  const cred = await prisma.googleCredential.findUnique({ where: { userId: ctx.userId } })
  if (!cred) return null

  // A week from the day start, so tomorrow's meetings can surface under `later`.
  const timeMin = ctx.window.start
  const timeMax = new Date(ctx.window.start.getTime() + WINDOW_DAYS * DAY_MS)

  // An InsufficientScopesError propagates: the collector maps it to needs_scope.
  const { events, complete } = await listEvents(ctx.userId, { timeMin, timeMax })

  const items = events.filter((event) => !isSkippable(event)).map((event) => toItem(event, ctx.tz))

  // Authority to resolve absent items only over a window that was fully read.
  return { items, resolveMissing: complete ? { start: timeMin, end: timeMax } : 'none' }
}
