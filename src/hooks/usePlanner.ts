'use client'

import { useState } from 'react'
import useSWR from 'swr'
import type {
  PlannerAction,
  PlannerSection,
  PlannerStatus,
  RankedItemDTO,
  TodayResponse,
  WriteThroughResult,
} from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §7.2 / §7.4. Client-only copy of
// time.ts's localDate (Intl only) — never import server modules here.
export function localDate(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function plannerKey(date: string, tz: string): string {
  return `/api/planner/today?date=${date}&tz=${encodeURIComponent(tz)}`
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

export interface UsePlannerArgs {
  date: string
  tz: string
}

export interface ActResult {
  ok: boolean
  error?: string
  writeThrough?: WriteThroughResult[]
}

export interface UsePlannerResult {
  data: TodayResponse | undefined
  error: Error | undefined
  isLoading: boolean
  mutate: () => Promise<unknown>
  act: (
    itemId: string,
    action: PlannerAction,
    extra?: { snoozedUntil?: string }
  ) => Promise<ActResult>
  addTodo: (title: string) => Promise<{ ok: boolean; error?: string }>
  refresh: () => Promise<void>
  plan: () => Promise<{ ok: boolean; error?: string }>
  busy: { refreshing: boolean; planning: boolean }
}

interface OptimisticFields {
  status: PlannerStatus
  section: PlannerSection
  resolvedBy: 'user' | null
  resolvedAt: string | null
  snoozedUntil: string | null
}

function optimisticFields(
  action: PlannerAction,
  extra: { snoozedUntil?: string } | undefined,
  nowIso: string
): OptimisticFields {
  switch (action) {
    case 'done':
      return {
        status: 'done',
        section: 'done',
        resolvedBy: 'user',
        resolvedAt: nowIso,
        snoozedUntil: null,
      }
    case 'dismiss':
      return {
        status: 'dismissed',
        section: 'dismissed',
        resolvedBy: 'user',
        resolvedAt: nowIso,
        snoozedUntil: null,
      }
    case 'wont_do':
      return {
        status: 'wont_do',
        section: 'wont_do',
        resolvedBy: 'user',
        resolvedAt: nowIso,
        snoozedUntil: null,
      }
    case 'snooze':
      return {
        status: 'snoozed',
        section: 'snoozed',
        resolvedBy: null,
        resolvedAt: null,
        snoozedUntil: extra?.snoozedUntil ?? null,
      }
    case 'reopen':
      return {
        status: 'open',
        section: 'today',
        resolvedBy: null,
        resolvedAt: null,
        snoozedUntil: null,
      }
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function usePlanner(args: UsePlannerArgs): UsePlannerResult {
  const key = plannerKey(args.date, args.tz)
  const { data, error, isLoading, mutate } = useSWR<TodayResponse>(key, fetcher, {
    refreshInterval: 60_000,
    shouldRetryOnError: (err: Error) => !['401', '403', '404'].includes(err.message),
  })
  const [refreshing, setRefreshing] = useState(false)
  const [planning, setPlanning] = useState(false)

  async function act(
    itemId: string,
    action: PlannerAction,
    extra?: { snoozedUntil?: string }
  ): Promise<ActResult> {
    if (!data) return { ok: false, error: 'Not loaded' }
    const idx = data.items.findIndex((i) => i.id === itemId)
    if (idx === -1) return { ok: false, error: 'Item not found' }
    const previous = data
    const prevItem = data.items[idx]
    const fields = optimisticFields(action, extra, new Date().toISOString())
    const optimisticItem: RankedItemDTO = { ...prevItem, ...fields }
    const next: TodayResponse = {
      ...data,
      items: data.items.map((it, i) => (i === idx ? optimisticItem : it)),
    }
    // Optimistic: patch the cache before the request leaves.
    mutate(next, false)

    const body: Record<string, unknown> = { action }
    if (action === 'snooze' && extra?.snoozedUntil) body.snoozedUntil = extra.snoozedUntil

    try {
      const res = await fetch(`/api/planner/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await readJson(res)
      if (!res.ok) {
        mutate(previous, false)
        return { ok: false, error: (json.error as string | undefined) ?? String(res.status) }
      }
      // Commit the optimistic value as the cache's truth first (so the status
      // + section move is never lost even if the revalidate below is slow),
      // then kick off a background revalidate to reconcile anything the
      // write-through changed server-side (e.g. a card move).
      mutate(next, false)
      mutate()
      return { ok: true, writeThrough: json.writeThrough as WriteThroughResult[] | undefined }
    } catch (err) {
      mutate(previous, false)
      return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
    }
  }

  async function addTodo(title: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch('/api/planner/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      const json = await readJson(res)
      if (!res.ok)
        return { ok: false, error: (json.error as string | undefined) ?? String(res.status) }
      mutate()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
    }
  }

  async function refresh(): Promise<void> {
    setRefreshing(true)
    try {
      const res = await fetch(`${key}&refresh=1`)
      if (res.ok) {
        const json = (await readJson(res)) as unknown as TodayResponse
        mutate(json, false)
      }
      await mutate()
    } finally {
      setRefreshing(false)
    }
  }

  async function plan(): Promise<{ ok: boolean; error?: string }> {
    setPlanning(true)
    try {
      const res = await fetch('/api/planner/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: args.date, tz: args.tz }),
      })
      const json = await readJson(res)
      if (!res.ok)
        return { ok: false, error: (json.error as string | undefined) ?? String(res.status) }
      await mutate()
      return { ok: true }
    } finally {
      setPlanning(false)
    }
  }

  return {
    data,
    error,
    isLoading,
    mutate,
    act,
    addTodo,
    refresh,
    plan,
    busy: { refreshing, planning },
  }
}
