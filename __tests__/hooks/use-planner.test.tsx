// @vitest-environment jsdom
/**
 * usePlanner — spec §7.2: key builder, the house fetcher, optimistic `act`
 * with rollback on a non-ok response, and a 200 that carries a failed
 * write-through (the status change stands; the caller surfaces it). (WI-5)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, act as reactAct } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { usePlanner, plannerKey, localDate } from '../../src/hooks/usePlanner'
import {
  rankedItem,
  todayResponse,
  installFetch,
  deferred,
  sleep,
  T0,
} from '../components/_helpers/planner-fixtures'
import type { FetchReply } from '../components/_helpers/planner-fixtures'

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  )
}

const ARGS = { date: '2026-09-16', tz: 'UTC' }

describe('plannerKey / localDate', () => {
  it('builds the today key with an encoded zone', () => {
    expect(plannerKey('2026-09-16', 'Europe/London')).toBe(
      '/api/planner/today?date=2026-09-16&tz=Europe%2FLondon'
    )
    expect(plannerKey('2026-09-16', 'UTC')).toBe('/api/planner/today?date=2026-09-16&tz=UTC')
  })

  it('localDate follows the zone, not UTC', () => {
    const t = new Date('2026-09-16T23:30:00Z')
    expect(localDate(t, 'America/New_York')).toBe('2026-09-16')
    expect(localDate(t, 'Asia/Tokyo')).toBe('2026-09-17')
    expect(localDate(t, 'UTC')).toBe('2026-09-16')
  })
})

describe('usePlanner', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads the day through the house fetcher and exposes it', async () => {
    const f = installFetch(() => ({ json: todayResponse([rankedItem()]) }))
    const { result } = renderHook(() => usePlanner(ARGS), { wrapper })
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(f.calls[0].url).toBe('/api/planner/today?date=2026-09-16&tz=UTC')
    expect(result.current.data!.items[0].id).toBe('it-1')
    expect(result.current.busy).toEqual({ refreshing: false, planning: false })
  })

  it('surfaces a non-ok load as an error carrying the status', async () => {
    installFetch(() => ({ status: 401, json: { error: 'Unauthorized' } }))
    const { result } = renderHook(() => usePlanner(ARGS), { wrapper })
    await waitFor(() => expect(result.current.error).toBeDefined())
    expect(result.current.error!.message).toBe('401')
    expect(result.current.data).toBeUndefined()
  })

  it('act is optimistic (status + section move at once) and rolls back on a non-ok response', async () => {
    const patch = deferred<FetchReply>()
    const f = installFetch((c) =>
      c.method === 'PATCH' ? patch.promise : { json: todayResponse([rankedItem()]) }
    )
    const { result } = renderHook(() => usePlanner(ARGS), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    let p!: Promise<{ ok: boolean; error?: string }>
    reactAct(() => {
      p = result.current.act('it-1', 'done')
    })
    await waitFor(() => expect(result.current.data!.items[0].status).toBe('done'))
    expect(result.current.data!.items[0].section).toBe('done')

    patch.resolve({ status: 404, json: { error: 'Item not found' } })
    await expect(p).resolves.toEqual({ ok: false, error: 'Item not found' })
    await waitFor(() => expect(result.current.data!.items[0].status).toBe('open'))
    expect(result.current.data!.items[0].section).toBe('now')

    const call = f.of('PATCH', /\/api\/planner\/items\/it-1$/)
    expect(call).toHaveLength(1)
    expect(call[0].body).toEqual({ action: 'done' })
  })

  it('a 200 carrying a failed write-through resolves { ok: true, writeThrough } and never rolls back', async () => {
    const wt = [{ kind: 'card_moved', ok: false, error: "couldn't move the card" }]
    const doneItem = rankedItem({
      status: 'done',
      section: 'done',
      resolvedBy: 'user',
      resolvedAt: T0,
    })
    const state = { today: todayResponse([rankedItem()]) }
    const seen: string[] = []
    installFetch((c) => {
      if (c.method === 'PATCH') {
        state.today = todayResponse([doneItem])
        return { json: { item: doneItem, writeThrough: wt } }
      }
      return { json: state.today }
    })
    const { result } = renderHook(
      () => {
        const r = usePlanner(ARGS)
        if (r.data) seen.push(r.data.items[0].status)
        return r
      },
      { wrapper }
    )
    await waitFor(() => expect(result.current.data).toBeDefined())

    let res: unknown
    await reactAct(async () => {
      res = await result.current.act('it-1', 'done')
    })
    expect(res).toEqual({ ok: true, writeThrough: wt })
    await waitFor(() => expect(result.current.data!.items[0].status).toBe('done'))
    // open (initial) → done (optimistic) → done (refetched); never back to open
    expect(seen.slice(seen.indexOf('done'))).not.toContain('open')
  })

  it('snooze sends snoozedUntil and parks the item in the snoozed section; reopen returns it to today', async () => {
    const until = '2026-09-17T09:00:00.000Z'
    const f = installFetch((c) =>
      c.method === 'PATCH'
        ? {
            json: {
              item: rankedItem({ status: 'snoozed', snoozedUntil: until }),
              writeThrough: [],
            },
          }
        : { json: todayResponse([rankedItem()]) }
    )
    const { result } = renderHook(() => usePlanner(ARGS), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    let snoozePromise!: Promise<unknown>
    reactAct(() => {
      snoozePromise = result.current.act('it-1', 'snooze', { snoozedUntil: until })
    })
    await waitFor(() => expect(result.current.data!.items[0].section).toBe('snoozed'))
    await reactAct(async () => {
      await snoozePromise
    })
    expect(f.of('PATCH', /items\/it-1$/)[0].body).toEqual({ action: 'snooze', snoozedUntil: until })

    const doneRow = rankedItem({ status: 'done', section: 'done' })
    const reopened = rankedItem({ status: 'open', section: 'today' })
    const state = { today: todayResponse([doneRow]) }
    installFetch((c) => {
      if (c.method === 'PATCH') {
        state.today = todayResponse([reopened])
        return { json: { item: reopened, writeThrough: [] } }
      }
      return { json: state.today }
    })
    const second = renderHook(() => usePlanner(ARGS), { wrapper })
    await waitFor(() => expect(second.result.current.data).toBeDefined())
    let reopenPromise!: Promise<unknown>
    reactAct(() => {
      reopenPromise = second.result.current.act('it-1', 'reopen')
    })
    await waitFor(() => {
      expect(second.result.current.data!.items[0].section).toBe('today')
      expect(second.result.current.data!.items[0].status).toBe('open')
    })
    await reactAct(async () => {
      await reopenPromise
    })
    expect(second.result.current.data!.items[0].status).toBe('open')
  })

  it('addTodo posts the title and refetches; a failure reports the server message', async () => {
    const f = installFetch((c) => {
      if (c.method === 'POST' && /\/api\/planner\/items$/.test(c.url)) {
        const title = (c.body as { title: string }).title
        return title === 'boom'
          ? { status: 400, json: { error: 'Validation failed' } }
          : { status: 201, json: { item: rankedItem({ id: 'm1', source: 'manual', title }) } }
      }
      return { json: todayResponse([rankedItem()]) }
    })
    const { result } = renderHook(() => usePlanner(ARGS), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    const gets = () => f.of('GET', /\/api\/planner\/today/).length
    const before = gets()

    let res: unknown
    await reactAct(async () => {
      res = await result.current.addTodo('Buy milk')
    })
    expect(res).toEqual({ ok: true })
    expect(f.of('POST', /\/api\/planner\/items$/)[0].body).toEqual({ title: 'Buy milk' })
    await waitFor(() => expect(gets()).toBeGreaterThan(before))

    await reactAct(async () => {
      res = await result.current.addTodo('boom')
    })
    expect(res).toEqual({ ok: false, error: 'Validation failed' })
  })

  it('refresh requests &refresh=1, flips busy.refreshing, then revalidates', async () => {
    const f = installFetch(() => ({ json: todayResponse([rankedItem()]) }))
    const { result } = renderHook(() => usePlanner(ARGS), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    let p!: Promise<void>
    reactAct(() => {
      p = result.current.refresh()
    })
    await waitFor(() => expect(result.current.busy.refreshing).toBe(true))
    await reactAct(async () => {
      await p
    })
    expect(result.current.busy.refreshing).toBe(false)
    expect(f.of('GET', /refresh=1/).map((c) => c.url)).toEqual([
      '/api/planner/today?date=2026-09-16&tz=UTC&refresh=1',
    ])
  })

  it('plan posts { date, tz }, flips busy.planning, and reports the server message on failure', async () => {
    const state = { status: 200 }
    const f = installFetch((c) => {
      if (c.method === 'POST' && /\/api\/planner\/plan$/.test(c.url)) {
        return state.status === 200
          ? {
              json: {
                brief: '# Today',
                model: 'm',
                updatedItems: 1,
                inputTokens: 1,
                outputTokens: 1,
              },
            }
          : { status: 429, json: { error: 'Plan my day is limited to 3 runs per 10 minutes' } }
      }
      return { json: todayResponse([rankedItem()]) }
    })
    const { result } = renderHook(() => usePlanner(ARGS), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    let p!: Promise<{ ok: boolean; error?: string }>
    reactAct(() => {
      p = result.current.plan()
    })
    await waitFor(() => expect(result.current.busy.planning).toBe(true))
    let res: unknown
    await reactAct(async () => {
      res = await p
    })
    expect(res).toEqual({ ok: true })
    expect(result.current.busy.planning).toBe(false)
    expect(f.of('POST', /\/api\/planner\/plan$/)[0].body).toEqual({ date: '2026-09-16', tz: 'UTC' })

    state.status = 429
    await reactAct(async () => {
      res = await result.current.plan()
    })
    expect(res).toEqual({ ok: false, error: 'Plan my day is limited to 3 runs per 10 minutes' })
    await sleep(10)
  })
})
