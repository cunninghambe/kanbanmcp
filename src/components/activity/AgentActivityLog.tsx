'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Pip } from '@/components/design/Pip'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface AgentActivity {
  id: string
  agentName: string
  action: string
  resourceType: string
  resourceId: string
  metadata: Record<string, unknown> | string
  createdAt: string
}

interface ActivityResponse {
  activities: AgentActivity[]
  total: number
  page: number
  limit: number
}

function pipToneForAction(action: string): 'ok' | 'warn' | 'err' | 'accent' | 'default' {
  const a = action.toLowerCase()
  if (a.includes('error') || a.includes('fail')) return 'err'
  if (a.includes('warn')) return 'warn'
  if (a.includes('create') || a.includes('done') || a.includes('complete')) return 'ok'
  if (a.includes('move') || a.includes('update') || a.includes('toggle')) return 'accent'
  return 'default'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * Agent activity log — restyled to match the design system.
 * Renders a scrollable list of mono entries with hairline row dividers,
 * pip status indicators, and an optional agent-name filter.
 * Pagination preserved; maximum 20 entries per page.
 */
export function AgentActivityLog() {
  const [agentFilter, setAgentFilter] = useState('')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const query = new URLSearchParams({ page: String(page), limit: '20' })
  if (agentFilter.trim()) query.set('agentName', agentFilter.trim())

  const { data, isLoading } = useSWR<ActivityResponse>(
    `/api/activity?${query.toString()}`,
    fetcher,
    { refreshInterval: 10_000 }
  )

  const activities = data?.activities ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / 20)

  function handleFilterChange(val: string) {
    setAgentFilter(val)
    setPage(1)
  }

  return (
    <section style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }} aria-label="Agent activity log">
      {/* header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: 'var(--bg-2)',
        }}
      >
        <span className="km-eyebrow flex-1" style={{ fontSize: 10, color: 'var(--fg-1)' }}>
          {'/// agent activity'}
        </span>
        <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
          {total} {total === 1 ? 'entry' : 'entries'}
        </span>
        {/* filter */}
        <input
          type="text"
          value={agentFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
          placeholder="filter agent…"
          aria-label="Filter by agent name"
          className="km-input"
          style={{ width: 140, height: 26, fontSize: 11, padding: '0 8px' }}
        />
        {agentFilter && (
          <button
            className="km-btn km-btn--ghost km-btn--sm"
            onClick={() => handleFilterChange('')}
            aria-label="Clear filter"
          >
            ✕
          </button>
        )}
      </div>

      {/* entries */}
      {isLoading ? (
        <div className="km-mono" style={{ padding: '16px', fontSize: 11, color: 'var(--fg-3)' }}>
          loading activity…
        </div>
      ) : activities.length === 0 ? (
        <div className="km-mono" style={{ padding: '16px', fontSize: 11, color: 'var(--fg-3)' }}>
          {agentFilter ? `no activity from "${agentFilter}"` : 'no agent activity yet'}
        </div>
      ) : (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.7 }}>
          {activities.map((activity, i) => {
            const metaStr =
              typeof activity.metadata === 'object'
                ? JSON.stringify(activity.metadata)
                : String(activity.metadata ?? '')
            const isExpanded = expandedId === activity.id
            const isLong = metaStr.length > 60

            return (
              <div
                key={activity.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '8px 42px 90px 1fr 120px',
                  alignItems: 'baseline',
                  gap: 10,
                  padding: '6px 16px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--line-faint)',
                  color: 'var(--fg-2)',
                }}
              >
                <Pip tone={pipToneForAction(activity.action)} />
                <span style={{ color: 'var(--fg-3)', letterSpacing: '0.04em' }}>
                  {formatTime(activity.createdAt)}
                </span>
                <span style={{ color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activity.agentName}
                </span>
                <span style={{ color: 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activity.action}
                  {activity.resourceId && (
                    <> → <span style={{ color: 'var(--fg-1)' }}>{activity.resourceId}</span></>
                  )}
                </span>
                <div style={{ minWidth: 0 }}>
                  {isLong ? (
                    <>
                      <span style={{ color: 'var(--fg-3)' }}>
                        {isExpanded ? metaStr : `${metaStr.slice(0, 40)}…`}
                      </span>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : activity.id)}
                        style={{ display: 'block', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', padding: 0 }}
                        aria-label={isExpanded ? 'Collapse metadata' : 'Expand metadata'}
                      >
                        {isExpanded ? '▲ less' : '▼ more'}
                      </button>
                    </>
                  ) : (
                    <span style={{ color: 'var(--fg-3)' }}>{metaStr}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* pagination */}
      {totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 16px',
            borderTop: '1px solid var(--line)',
            background: 'var(--bg-2)',
          }}
        >
          <button
            className="km-btn km-btn--sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            ← prev
          </button>
          <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
            {page} / {totalPages}
          </span>
          <button
            className="km-btn km-btn--sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            next →
          </button>
        </div>
      )}
    </section>
  )
}
