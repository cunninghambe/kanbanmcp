'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { RefreshCw, Sparkles } from 'lucide-react'
import { Topbar } from '@/components/design/Topbar'
import { StatTile } from '@/components/design/StatTile'
import { SourceStatus } from '@/components/planner/SourceStatus'
import { PlannerList } from '@/components/planner/PlannerList'
import { QuickAdd } from '@/components/planner/QuickAdd'
import { Workspace } from '@/components/planner/Workspace'
import { usePlanner, localDate } from '@/hooks/usePlanner'
import { useSession } from '@/hooks/useSession'
import styles from './today.module.css'

// Spec: docs/specs/mhud-today-planner.md §7.3 / §7.4 (the `/today` page).

function buildTitle(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(new Date(y, m - 1, d, 12))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')}`.toLowerCase()
}

/** `?date=YYYY-MM-DD` and a real calendar date; anything else falls back to today. */
function isValidDateParam(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
}

function TodayInner() {
  const searchParams = useSearchParams()
  const { org } = useSession()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const dateParam = searchParams.get('date')
  const date = dateParam && isValidDateParam(dateParam) ? dateParam : localDate(new Date(), tz)
  const { data, error, isLoading, act, addTodo, refresh, plan, busy } = usePlanner({ date, tz })
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('item'))
  const [planError, setPlanError] = useState<string | null>(null)

  const title = buildTitle(date)

  async function handlePlan() {
    setPlanError(null)
    const res = await plan()
    if (!res.ok) setPlanError(res.error ?? 'Plan my day failed')
  }

  const right = (
    <div className="flex items-center gap-2">
      {data && <SourceStatus sources={data.sources} sourceErrors={data.sourceErrors} />}
      <div style={{ width: 1, height: 20, background: 'var(--line)' }} />
      <button
        type="button"
        aria-label="Refresh"
        onClick={() => void refresh()}
        disabled={busy.refreshing}
        className="km-btn km-btn--sm"
      >
        <RefreshCw size={13} />
      </button>
      <button
        type="button"
        onClick={() => void handlePlan()}
        disabled={busy.planning}
        className="km-btn km-btn--primary km-btn--sm"
      >
        <Sparkles size={13} /> plan my day
      </button>
    </div>
  )

  if (isLoading) {
    return (
      <>
        <Topbar breadcrumb="today" title={title} right={right} />
        <div
          className="km-mono"
          style={{ padding: 24, fontSize: 12, color: 'var(--fg-3)', letterSpacing: '0.06em' }}
        >
          loading…
        </div>
      </>
    )
  }

  if (error && !data) {
    return (
      <>
        <Topbar breadcrumb="today" title={title} right={right} />
        <div
          role="alert"
          className="km-mono"
          style={{ padding: 24, fontSize: 12, color: 'var(--err)' }}
        >
          couldn&apos;t load today · {error.message}
        </div>
      </>
    )
  }

  if (!data) return null

  const selectedItem = data.items.find((i) => i.id === selectedId) ?? null

  return (
    <>
      <Topbar breadcrumb="today" title={title} right={right} />

      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg-1)',
          flexShrink: 0,
        }}
      >
        <StatTile label="now" value={data.counts.now} />
        <StatTile
          label="overdue"
          value={data.counts.overdue}
          accent={data.counts.overdue > 0 ? 'err' : 'default'}
        />
        <StatTile label="meetings today" value={data.counts.meetingsToday} />
        <StatTile label="inbox" value={data.counts.inbox} />
        <StatTile label="slack" value={data.counts.slack} />
        <StatTile label="done today" value={data.counts.doneToday} divider={false} />
      </div>

      {planError && (
        <div
          role="alert"
          className="km-mono"
          style={{ padding: '6px 20px', fontSize: 11, color: 'var(--err)' }}
        >
          {planError}
        </div>
      )}

      <div className={styles.body}>
        <div className={styles.left}>
          {error && (
            <div role="status" className="km-mono" style={{ fontSize: 11, color: 'var(--warn)' }}>
              couldn&apos;t refresh · {error.message}
            </div>
          )}
          {data.truncated && (
            <div
              className="km-mono"
              style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.04em' }}
            >
              showing the newest 500 open items
            </div>
          )}
          <PlannerList data={data} selectedId={selectedId} onSelect={setSelectedId} act={act} />
          <QuickAdd onAdd={addTodo} />
        </div>
        <div className={styles.workspacePane}>
          <Workspace item={selectedItem} brief={data.brief} orgId={org?.id ?? ''} />
        </div>
      </div>
    </>
  )
}

export default function TodayPage() {
  return (
    <Suspense fallback={null}>
      <TodayInner />
    </Suspense>
  )
}
