/**
 * Calendar source (spec §4.5 calendar.ts): 7-day window, skips declined /
 * cancelled / free events, maps all-day events to their own local day, and only
 * claims resolution authority over a fully-read window. (WI-2)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  googleCredential: { findUnique: vi.fn() },
}))
vi.mock('../../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const cal = vi.hoisted(() => ({ listEvents: vi.fn() }))
vi.mock('../../../src/lib/google/calendar', () => ({
  listEvents: (...a: unknown[]) => cal.listEvents(...a),
}))

import { readCalendar } from '../../../src/lib/planner/sources/calendar'
import type { CalendarEvent } from '../../../src/lib/google/calendar'
import type { SourceContext } from '../../../src/lib/planner/types'
import { dayBounds } from '../../../src/lib/planner/time'
import { InsufficientScopesError } from '../../../src/lib/google/errors'

const TZ = 'America/New_York' // UTC-4 in September
const NOW = new Date('2026-09-16T13:00:00Z') // 09:00 local
const WINDOW = dayBounds('2026-09-16', TZ) // 2026-09-16T04:00Z → 2026-09-17T04:00Z
const CTX: SourceContext = { userId: 'user-1', orgId: 'org-1', tz: TZ, now: NOW, window: WINDOW }
const DAY = 24 * 60 * 60 * 1000

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ev1',
    summary: 'Exec sync',
    description: null,
    htmlLink: 'https://www.google.com/calendar/event?eid=ev1',
    start: new Date('2026-09-16T14:00:00Z'),
    end: new Date('2026-09-16T15:00:00Z'),
    allDay: false,
    startDate: null,
    endDate: null,
    status: 'confirmed',
    transparency: null,
    location: null,
    hangoutLink: null,
    organizer: { email: 'boss@example.com', name: 'Boss' },
    attendees: [
      { email: 'me@example.com', name: 'Me', responseStatus: 'accepted', self: true },
      { email: 'boss@example.com', name: 'Boss', responseStatus: 'accepted' },
    ],
    ...over,
  }
}

describe('planner/sources/calendar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.googleCredential.findUnique.mockResolvedValue({ userId: 'user-1', scopes: 'x' })
    cal.listEvents.mockResolvedValue({ events: [], complete: true })
  })

  it('returns null (skipped) without calling Google when the user has no Google credential', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(null)
    expect(await readCalendar(CTX)).toBeNull()
    expect(cal.listEvents).not.toHaveBeenCalled()
  })

  it('asks for a 7-day window starting at the day start', async () => {
    await readCalendar(CTX)
    expect(cal.listEvents).toHaveBeenCalledWith('user-1', {
      timeMin: WINDOW.start,
      timeMax: new Date(WINDOW.start.getTime() + 7 * DAY),
    })
  })

  it('lets an InsufficientScopesError propagate (the collector maps it to needs_scope)', async () => {
    cal.listEvents.mockRejectedValue(
      new InsufficientScopesError(['https://www.googleapis.com/auth/calendar.events.readonly'])
    )
    await expect(readCalendar(CTX)).rejects.toBeInstanceOf(InsufficientScopesError)
  })

  it('maps a timed event with attendee summary, link and payload', async () => {
    cal.listEvents.mockResolvedValue({
      events: [
        ev({ location: 'Room 4', hangoutLink: 'https://meet.google.com/x', description: 'agenda' }),
      ],
      complete: true,
    })
    const read = await readCalendar(CTX)
    expect(read!.items).toEqual([
      {
        sourceKey: 'calendar:ev1',
        title: 'Exec sync',
        summary: 'Me, Boss',
        url: 'https://www.google.com/calendar/event?eid=ev1',
        startsAt: new Date('2026-09-16T14:00:00Z'),
        endsAt: new Date('2026-09-16T15:00:00Z'),
        payload: {
          eventId: 'ev1',
          attendees: [
            { email: 'me@example.com', name: 'Me', responseStatus: 'accepted', self: true },
            { email: 'boss@example.com', name: 'Boss', responseStatus: 'accepted', self: false },
          ],
          organizer: { email: 'boss@example.com', name: 'Boss' },
          location: 'Room 4',
          hangoutLink: 'https://meet.google.com/x',
          description: 'agenda',
          allDay: false,
        },
      },
    ])
    expect(read!.resolveMissing).toEqual({
      start: WINDOW.start,
      end: new Date(WINDOW.start.getTime() + 7 * DAY),
    })
  })

  it('summarises at most 6 attendee names then "+N", using the email when there is no name', async () => {
    const attendees = Array.from({ length: 8 }, (_, i) => ({
      email: `p${i}@x.com`,
      name: i < 7 ? `P${i}` : undefined,
      responseStatus: 'accepted',
    }))
    cal.listEvents.mockResolvedValue({ events: [ev({ attendees })], complete: true })
    const [item] = (await readCalendar(CTX))!.items
    expect(item.summary).toBe('P0, P1, P2, P3, P4, P5 +2')
    const solo = ev({ id: 'e2', attendees: [{ email: 'anon@x.com' }] })
    cal.listEvents.mockResolvedValue({ events: [solo], complete: true })
    expect((await readCalendar(CTX))!.items[0].summary).toBe('anon@x.com')
  })

  it('truncates long descriptions to 2000 chars and titles missing summaries', async () => {
    cal.listEvents.mockResolvedValue({
      events: [ev({ summary: null, description: 'x'.repeat(5000) })],
      complete: true,
    })
    const [item] = (await readCalendar(CTX))!.items
    expect(item.title).toBe('(no title)')
    expect((item.payload.description as string).length).toBe(2000)
  })

  it('skips declined (self), cancelled and transparent events', async () => {
    cal.listEvents.mockResolvedValue({
      events: [
        ev({
          id: 'declined',
          attendees: [{ email: 'me@example.com', responseStatus: 'declined', self: true }],
        }),
        ev({ id: 'cancelled', status: 'cancelled' }),
        ev({ id: 'free', transparency: 'transparent' }),
        ev({ id: 'keep' }),
        ev({ id: 'other-declined', attendees: [{ email: 'x@y.z', responseStatus: 'declined' }] }),
      ],
      complete: true,
    })
    const read = await readCalendar(CTX)
    expect(read!.items.map((i) => i.sourceKey)).toEqual([
      'calendar:keep',
      'calendar:other-declined',
    ])
  })

  it('maps an all-day event to its own local day bounds in ctx.tz (end.date is exclusive)', async () => {
    cal.listEvents.mockResolvedValue({
      events: [
        ev({
          id: 'offsite',
          allDay: true,
          startDate: '2026-09-18',
          endDate: '2026-09-20',
          start: new Date('2026-09-18T00:00:00Z'),
          end: new Date('2026-09-20T00:00:00Z'),
        }),
        ev({
          id: 'today',
          allDay: true,
          startDate: '2026-09-16',
          endDate: '2026-09-17',
          start: new Date('2026-09-16T00:00:00Z'),
          end: new Date('2026-09-17T00:00:00Z'),
        }),
      ],
      complete: true,
    })
    const items = (await readCalendar(CTX))!.items
    const offsite = items.find((i) => i.sourceKey === 'calendar:offsite')!
    expect(offsite.startsAt).toEqual(dayBounds('2026-09-18', TZ).start) // 2026-09-18T04:00Z
    expect(offsite.endsAt).toEqual(dayBounds('2026-09-19', TZ).end) // 2026-09-20T04:00Z (two local days)
    expect(offsite.payload.allDay).toBe(true)

    const today = items.find((i) => i.sourceKey === 'calendar:today')!
    expect(today.startsAt).toEqual(WINDOW.start)
    expect(today.endsAt).toEqual(WINDOW.end)
  })

  it('claims no resolution authority when the read was truncated', async () => {
    cal.listEvents.mockResolvedValue({ events: [ev()], complete: false })
    const read = await readCalendar(CTX)
    expect(read!.items).toHaveLength(1)
    expect(read!.resolveMissing).toBe('none')
  })
})
