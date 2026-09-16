/**
 * Google Calendar read (spec §4.6 calendar.ts): scope precheck, paginated
 * events list, status ladder, event parsing. Network via the raw fetch seam so
 * retry behaviour is observable. (WI-2)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  assertScopes: vi.fn(),
}))
vi.mock('../../../src/lib/google/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/google/oauth')>()
  return {
    ...actual,
    ensureFreshAccessToken: (...a: unknown[]) => mocks.ensureFreshAccessToken(...a),
  }
})
vi.mock('../../../src/lib/google/scopes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/google/scopes')>()
  return { ...actual, assertScopes: (...a: unknown[]) => mocks.assertScopes(...a) }
})

import { listEvents } from '../../../src/lib/google/calendar'
import { CALENDAR_EVENTS_READONLY_SCOPE } from '../../../src/lib/google/scopes'
import {
  __setFetchSleeperForTests,
  __setRawFetchForTests,
  __setGoogleFetchForTests,
} from '../../../src/lib/google/fetch'
import { __resetBucketsForTests } from '../../../src/lib/google/rate-limit'
import {
  GoogleAuthExpiredError,
  GoogleHttpError,
  InsufficientScopesError,
} from '../../../src/lib/google/errors'

type Call = {
  url: string
  init?: { method?: string; headers?: Record<string, string>; body?: string }
}

function responder(pages: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = []
  let i = 0
  const fetch = vi.fn(async (url: string, init?: Call['init']) => {
    calls.push({ url, init })
    const page = pages[Math.min(i, pages.length - 1)]
    i += 1
    const text = JSON.stringify(page.body)
    return {
      status: page.status,
      ok: page.status >= 200 && page.status < 300,
      text: async () => text,
      json: async () => page.body,
    }
  })
  return { fetch, calls }
}

const TIME_MIN = new Date('2026-09-16T00:00:00Z')
const TIME_MAX = new Date('2026-09-23T00:00:00Z')

describe('google/calendar listEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureFreshAccessToken.mockResolvedValue('tok-123')
    mocks.assertScopes.mockResolvedValue(undefined)
    __setFetchSleeperForTests(async () => {})
  })
  afterEach(() => {
    __setRawFetchForTests(null)
    __setGoogleFetchForTests(null)
    __resetBucketsForTests()
  })

  it('checks the calendar scope before spending a Google call', async () => {
    mocks.assertScopes.mockRejectedValue(
      new InsufficientScopesError([CALENDAR_EVENTS_READONLY_SCOPE])
    )
    const { fetch } = responder([{ status: 200, body: { items: [] } }])
    __setRawFetchForTests(fetch)
    await expect(
      listEvents('user-1', { timeMin: TIME_MIN, timeMax: TIME_MAX })
    ).rejects.toBeInstanceOf(InsufficientScopesError)
    expect(mocks.assertScopes).toHaveBeenCalledWith('user-1', [CALENDAR_EVENTS_READONLY_SCOPE])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('calls the primary calendar with singleEvents, orderBy, the window and the bearer token', async () => {
    const { fetch, calls } = responder([{ status: 200, body: { items: [] } }])
    __setRawFetchForTests(fetch)
    const res = await listEvents('user-1', { timeMin: TIME_MIN, timeMax: TIME_MAX })
    expect(res).toEqual({ events: [], complete: true })
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url)
    expect(url.origin + url.pathname).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events'
    )
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(url.searchParams.get('orderBy')).toBe('startTime')
    expect(url.searchParams.get('timeMin')).toBe(TIME_MIN.toISOString())
    expect(url.searchParams.get('timeMax')).toBe(TIME_MAX.toISOString())
    expect(url.searchParams.get('maxResults')).toBe('250')
    expect(url.searchParams.get('pageToken')).toBeNull()
    expect(calls[0].init?.headers?.Authorization).toBe('Bearer tok-123')
  })

  it('follows nextPageToken until the last page and concatenates items', async () => {
    const { fetch, calls } = responder([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'a',
              summary: 'A',
              start: { dateTime: '2026-09-16T10:00:00Z' },
              end: { dateTime: '2026-09-16T11:00:00Z' },
            },
          ],
          nextPageToken: 'p2',
        },
      },
      {
        status: 200,
        body: {
          items: [
            {
              id: 'b',
              summary: 'B',
              start: { dateTime: '2026-09-17T10:00:00Z' },
              end: { dateTime: '2026-09-17T11:00:00Z' },
            },
          ],
          nextPageToken: 'p3',
        },
      },
      {
        status: 200,
        body: {
          items: [
            {
              id: 'c',
              summary: 'C',
              start: { dateTime: '2026-09-18T10:00:00Z' },
              end: { dateTime: '2026-09-18T11:00:00Z' },
            },
          ],
        },
      },
    ])
    __setRawFetchForTests(fetch)
    const res = await listEvents('user-1', { timeMin: TIME_MIN, timeMax: TIME_MAX })
    expect(res.complete).toBe(true)
    expect(res.events.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(calls.map((c) => new URL(c.url).searchParams.get('pageToken'))).toEqual([
      null,
      'p2',
      'p3',
    ])
  })

  it('stops at maxPages and reports complete: false', async () => {
    const { fetch, calls } = responder([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'x',
              start: { dateTime: '2026-09-16T10:00:00Z' },
              end: { dateTime: '2026-09-16T11:00:00Z' },
            },
          ],
          nextPageToken: 'more',
        },
      },
    ])
    __setRawFetchForTests(fetch)
    const res = await listEvents('user-1', {
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
      maxPages: 2,
      pageSize: 50,
    })
    expect(calls).toHaveLength(2)
    expect(new URL(calls[0].url).searchParams.get('maxResults')).toBe('50')
    expect(res.complete).toBe(false)
    expect(res.events).toHaveLength(2)
  })

  it('maps 401 → GoogleAuthExpiredError, 403 → InsufficientScopesError, other → GoogleHttpError', async () => {
    __setRawFetchForTests(responder([{ status: 401, body: { error: 'x' } }]).fetch)
    await expect(
      listEvents('user-1', { timeMin: TIME_MIN, timeMax: TIME_MAX })
    ).rejects.toBeInstanceOf(GoogleAuthExpiredError)

    __setRawFetchForTests(
      responder([{ status: 403, body: { error: { message: 'Insufficient Permission' } } }]).fetch
    )
    const err = await listEvents('user-1', { timeMin: TIME_MIN, timeMax: TIME_MAX }).catch((e) => e)
    expect(err).toBeInstanceOf(InsufficientScopesError)
    expect((err as InsufficientScopesError).missing).toEqual([CALENDAR_EVENTS_READONLY_SCOPE])

    __setRawFetchForTests(responder([{ status: 404, body: { error: 'nope' } }]).fetch)
    const err2 = await listEvents('user-1', { timeMin: TIME_MIN, timeMax: TIME_MAX }).catch(
      (e) => e
    )
    expect(err2).toBeInstanceOf(GoogleHttpError)
    expect((err2 as GoogleHttpError).status).toBe(404)
  })

  it('retries a 503 (retry on, per-user bucket on) and succeeds on the second attempt', async () => {
    const { fetch } = responder([
      { status: 503, body: {} },
      { status: 200, body: { items: [] } },
    ])
    __setRawFetchForTests(fetch)
    const res = await listEvents('user-1', { timeMin: TIME_MIN, timeMax: TIME_MAX })
    expect(res.complete).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('parses timed and all-day events, attendees and organizer', async () => {
    const { fetch } = responder([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'timed',
              summary: 'Exec sync',
              description: 'agenda…',
              htmlLink: 'https://www.google.com/calendar/event?eid=1',
              status: 'confirmed',
              transparency: 'opaque',
              location: 'Room 4',
              hangoutLink: 'https://meet.google.com/abc',
              organizer: { email: 'boss@example.com', displayName: 'Boss' },
              attendees: [
                {
                  email: 'me@example.com',
                  displayName: 'Me',
                  responseStatus: 'accepted',
                  self: true,
                },
                { email: 'boss@example.com', responseStatus: 'accepted' },
              ],
              start: { dateTime: '2026-09-16T10:00:00+01:00' },
              end: { dateTime: '2026-09-16T11:00:00+01:00' },
            },
            {
              id: 'allday',
              summary: 'Offsite',
              status: 'confirmed',
              start: { date: '2026-09-18' },
              end: { date: '2026-09-20' },
            },
            {
              id: 'bare',
              start: { dateTime: '2026-09-16T12:00:00Z' },
              end: { dateTime: '2026-09-16T12:30:00Z' },
            },
          ],
        },
      },
    ])
    __setRawFetchForTests(fetch)
    const { events } = await listEvents('user-1', { timeMin: TIME_MIN, timeMax: TIME_MAX })
    const [timed, allday, bare] = events

    expect(timed).toEqual({
      id: 'timed',
      summary: 'Exec sync',
      description: 'agenda…',
      htmlLink: 'https://www.google.com/calendar/event?eid=1',
      start: new Date('2026-09-16T09:00:00Z'),
      end: new Date('2026-09-16T10:00:00Z'),
      allDay: false,
      startDate: null,
      endDate: null,
      status: 'confirmed',
      transparency: 'opaque',
      location: 'Room 4',
      hangoutLink: 'https://meet.google.com/abc',
      organizer: { email: 'boss@example.com', name: 'Boss' },
      attendees: [
        { email: 'me@example.com', name: 'Me', responseStatus: 'accepted', self: true },
        { email: 'boss@example.com', responseStatus: 'accepted' },
      ],
    })

    expect(allday).toMatchObject({
      id: 'allday',
      summary: 'Offsite',
      allDay: true,
      startDate: '2026-09-18',
      endDate: '2026-09-20',
      start: new Date('2026-09-18T00:00:00Z'),
      end: new Date('2026-09-20T00:00:00Z'),
      attendees: [],
      organizer: null,
    })

    expect(bare).toMatchObject({
      id: 'bare',
      summary: null,
      description: null,
      htmlLink: null,
      status: 'confirmed',
      transparency: null,
      location: null,
      hangoutLink: null,
    })
  })

  it('does not go through the high-level stub when the raw seam is used, but respects it when set', async () => {
    __setGoogleFetchForTests(async () => ({
      status: 200,
      ok: true,
      text: async () => '{"items":[]}',
      json: async () => ({ items: [] }),
    }))
    const res = await listEvents('user-1', { timeMin: TIME_MIN, timeMax: TIME_MAX })
    expect(res).toEqual({ events: [], complete: true })
  })
})
