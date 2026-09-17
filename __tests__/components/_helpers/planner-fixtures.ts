/**
 * Shared fixtures for the Today planner frontend tests (WI-5).
 * Builds DTOs exactly as the API returns them (spec §4.1) and installs a
 * routed fetch stub so component tests never touch the network.
 */
import { vi } from 'vitest'
import type {
  PlannerDraftDTO,
  RankedItemDTO,
  TodayCounts,
  TodayResponse,
} from '../../../src/lib/planner/types'

export const T0 = '2026-09-16T08:00:00.000Z'

export function rankedItem(over: Partial<RankedItemDTO> = {}): RankedItemDTO {
  return {
    id: 'it-1',
    source: 'card',
    sourceKey: 'card:c1',
    title: 'Ship the release notes',
    summary: null,
    url: '/board/b1?card=c1',
    priority: 'high',
    dueAt: null,
    startsAt: null,
    endsAt: null,
    status: 'open',
    snoozedUntil: null,
    resolvedBy: null,
    resolvedAt: null,
    prepNotes: null,
    payload: { cardId: 'c1', boardId: 'b1', role: 'assignee' },
    lastSeenAt: T0,
    createdAt: T0,
    updatedAt: T0,
    score: 40,
    reasons: ['assigned to you'],
    section: 'now',
    ...over,
  }
}

export function emailItem(over: Partial<RankedItemDTO> = {}): RankedItemDTO {
  return rankedItem({
    id: 'it-email',
    source: 'email',
    sourceKey: 'email:e1',
    title: 'Contract renewal — Jane',
    url: 'https://mail.google.com/mail/u/0/#inbox/t1',
    payload: {
      cardId: 'e1',
      boardId: 'inbox-board',
      gmailThreadId: 't1',
      urgent: true,
      from: 'jane@example.com',
    },
    reasons: ['urgent email'],
    score: 45,
    ...over,
  })
}

export function slackItem(over: Partial<RankedItemDTO> = {}): RankedItemDTO {
  return rankedItem({
    id: 'it-slack',
    source: 'slack',
    sourceKey: 'slack:C1:1.2',
    title: 'Jane in #ops: can you look at the deploy?',
    url: 'https://acme.slack.com/archives/C1/p1200',
    payload: { channelId: 'C1', ts: '1.2', threadTs: null, kind: 'mention' },
    reasons: ['mentioned you'],
    score: 20,
    section: 'today',
    ...over,
  })
}

export function todayResponse(
  items: RankedItemDTO[],
  over: Partial<TodayResponse> = {}
): TodayResponse {
  const counts: TodayCounts = {
    now: 0,
    open: 0,
    overdue: 0,
    meetingsToday: 0,
    inbox: 0,
    slack: 0,
    doneToday: 0,
    dismissed: 0,
    ...(over.counts ?? {}),
  }
  return {
    date: '2026-09-16',
    tz: 'UTC',
    window: { start: '2026-09-16T00:00:00.000Z', end: '2026-09-17T00:00:00.000Z' },
    collectedAt: T0,
    sources: { card: 'ok', email: 'ok', calendar: 'ok', slack: 'ok' },
    sourceErrors: {},
    brief: null,
    items,
    truncated: false,
    ...over,
    counts,
  }
}

export function draftDTO(over: Partial<PlannerDraftDTO> = {}): PlannerDraftDTO {
  return {
    id: 'd1',
    itemId: 'it-email',
    title: 'Re: Contract renewal — Jane',
    body: 'Hello Jane,\n\nDone.',
    status: 'draft',
    handoff: null,
    pendingEmail: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

export interface FetchCall {
  method: string
  url: string
  body: unknown
}
export interface FetchReply {
  status?: number
  json?: unknown
}
export type FetchHandler = (call: FetchCall) => FetchReply | Promise<FetchReply>

/** Replaces global fetch with a router. Returns the recorded calls. */
export function installFetch(handler: FetchHandler) {
  const calls: FetchCall[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = undefined
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call: FetchCall = { method, url, body }
    calls.push(call)
    const reply = await handler(call)
    const status = reply.status ?? 200
    const json = reply.json ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
      headers: new Headers({ 'Content-Type': 'application/json' }),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fn)
  return {
    calls,
    fn,
    of: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url)),
  }
}

export function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
