// Google Calendar reads for the Today planner (spec §4.6).
// One paginated list call against the primary calendar; the caller (the planner
// calendar source) decides what to do with declined / cancelled / free events.

import { googleFetch } from './fetch'
import { ensureFreshAccessToken } from './oauth'
import { assertScopes, CALENDAR_EVENTS_READONLY_SCOPE } from './scopes'
import { GoogleAuthExpiredError, GoogleHttpError, InsufficientScopesError } from './errors'

const EVENTS_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const DEFAULT_PAGE_SIZE = 250
const DEFAULT_MAX_PAGES = 5

export interface CalendarAttendee {
  email: string
  name?: string
  responseStatus?: string
  self?: boolean
}

export interface CalendarEvent {
  id: string
  summary: string | null
  description: string | null
  htmlLink: string | null
  /** Instant bounds. For all-day events these are the UTC midnights of
   *  `startDate` / `endDate` — informational only; the planner source re-derives
   *  the local-day bounds in the user's zone. */
  start: Date
  end: Date
  allDay: boolean
  /** All-day events only: the raw 'YYYY-MM-DD' strings (`endDate` is exclusive). */
  startDate: string | null
  endDate: string | null
  status: string
  transparency: string | null
  location: string | null
  hangoutLink: string | null
  organizer: { email: string; name?: string } | null
  attendees: CalendarAttendee[]
}

export interface ListEventsResult {
  events: CalendarEvent[]
  /** false when the loop stopped at `maxPages` — the window was not fully read. */
  complete: boolean
}

// ─── Response parsing (tolerant: Google omits absent fields) ──────────────────

type RawTime = { dateTime?: unknown; date?: unknown }
type RawPerson = {
  email?: unknown
  displayName?: unknown
  responseStatus?: unknown
  self?: unknown
}
type RawEvent = {
  id?: unknown
  summary?: unknown
  description?: unknown
  htmlLink?: unknown
  status?: unknown
  transparency?: unknown
  location?: unknown
  hangoutLink?: unknown
  organizer?: RawPerson
  attendees?: RawPerson[]
  start?: RawTime
  end?: RawTime
}
type EventsListResponse = { items?: RawEvent[]; nextPageToken?: unknown }

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function midnightUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

function toAttendee(raw: RawPerson): CalendarAttendee {
  const attendee: CalendarAttendee = { email: str(raw.email) ?? '' }
  const name = str(raw.displayName)
  if (name) attendee.name = name
  const responseStatus = str(raw.responseStatus)
  if (responseStatus) attendee.responseStatus = responseStatus
  if (typeof raw.self === 'boolean') attendee.self = raw.self
  return attendee
}

function toOrganizer(raw: RawPerson | undefined): CalendarEvent['organizer'] {
  const email = raw ? str(raw.email) : null
  if (!email) return null
  const name = str(raw?.displayName)
  return name ? { email, name } : { email }
}

function parseEvent(raw: RawEvent): CalendarEvent | null {
  const id = str(raw.id)
  if (!id) return null

  const startDate = str(raw.start?.date)
  const startDateTime = str(raw.start?.dateTime)
  const endDate = str(raw.end?.date)
  const endDateTime = str(raw.end?.dateTime)

  const allDay = startDate !== null
  let start: Date
  let end: Date
  let resolvedEndDate: string | null = null

  if (allDay) {
    resolvedEndDate = endDate ?? nextDay(startDate)
    start = midnightUtc(startDate)
    end = midnightUtc(resolvedEndDate)
  } else {
    if (!startDateTime) return null
    start = new Date(startDateTime)
    end = endDateTime ? new Date(endDateTime) : start
  }

  return {
    id,
    summary: str(raw.summary),
    description: str(raw.description),
    htmlLink: str(raw.htmlLink),
    start,
    end,
    allDay,
    startDate: allDay ? startDate : null,
    endDate: allDay ? resolvedEndDate : null,
    status: str(raw.status) ?? 'confirmed',
    transparency: str(raw.transparency),
    location: str(raw.location),
    hangoutLink: str(raw.hangoutLink),
    organizer: toOrganizer(raw.organizer),
    attendees: Array.isArray(raw.attendees) ? raw.attendees.map(toAttendee) : [],
  }
}

// ─── Public read ──────────────────────────────────────────────────────────────

export async function listEvents(
  userId: string,
  args: { timeMin: Date; timeMax: Date; pageSize?: number; maxPages?: number }
): Promise<ListEventsResult> {
  // Scope precheck first: a missing scope must never spend a Google call.
  await assertScopes(userId, [CALENDAR_EVENTS_READONLY_SCOPE])
  const token = await ensureFreshAccessToken(userId)

  const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = args.maxPages ?? DEFAULT_MAX_PAGES

  const events: CalendarEvent[] = []
  let pageToken: string | null = null

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: args.timeMin.toISOString(),
      timeMax: args.timeMax.toISOString(),
      maxResults: String(pageSize),
    })
    if (pageToken) params.set('pageToken', pageToken)

    const res = await googleFetch(
      `${EVENTS_ENDPOINT}?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } },
      { userId, retry: true }
    )

    if (res.status === 401) throw new GoogleAuthExpiredError()
    if (res.status === 403) throw new InsufficientScopesError([CALENDAR_EVENTS_READONLY_SCOPE])
    if (!res.ok) throw new GoogleHttpError(res.status, await res.text())

    const body = (await res.json()) as EventsListResponse
    for (const raw of body.items ?? []) {
      const event = parseEvent(raw)
      if (event) events.push(event)
    }

    pageToken = str(body.nextPageToken)
    if (!pageToken) return { events, complete: true }
  }

  // Stopped at the page cap: the window was not fully read.
  return { events, complete: false }
}
