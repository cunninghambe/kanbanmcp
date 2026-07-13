'use client'

import { useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Topbar } from '@/components/design/Topbar'
import { Chip } from '@/components/design/Chip'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

type ChangeSetSummary = {
  id: string
  status: string
  summary: string | null
  hudSessionId: string | null
  hudSessionTitle: string | null
  itemCount: number
  createdAt: string
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | undefined> = {
  applied: 'ok',
  partially_applied: 'warn',
  pending: 'warn',
  rejected: 'err',
  expired: undefined,
}

const FILTERS = ['pending', 'applied', 'rejected', 'expired', 'all'] as const
type FilterStatus = (typeof FILTERS)[number]

function formatAge(iso: string): string {
  const diffMs = Math.max(0, Date.now() - new Date(iso).getTime())
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

export default function ChangesIndexPage() {
  const [filter, setFilter] = useState<FilterStatus>('pending')
  const query = filter === 'all' ? '' : `?status=${filter}`
  const { data, error, mutate } = useSWR<{ changeSets: ChangeSetSummary[] }>(`/api/changesets${query}`, fetcher)

  const changeSets = data?.changeSets ?? []

  return (
    <>
      <Topbar title="Changes" breadcrumb="// agents propose · humans approve" />

      {/* Toggle buttons, not status badges — raw km-chip styling instead of the read-only Chip component. */}
      <div role="group" aria-label="Filter changes by status" style={{ display: 'flex', gap: 8, padding: '14px 24px', borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
        {FILTERS.map((f) => {
          const active = filter === f
          return (
            <button
              key={f}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(f)}
              className="km-chip"
              style={{
                cursor: 'pointer',
                background: active ? 'var(--accent-tint)' : 'var(--bg-1)',
                borderColor: active ? 'var(--accent)' : 'var(--line)',
                color: active ? 'var(--accent)' : 'var(--fg-2)',
              }}
            >
              {f}
            </button>
          )
        })}
      </div>

      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 960 }}>
        <section style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
            <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>{'/// change sets'}</span>
          </div>
          {error ? (
            <div className="km-mono" role="alert" style={{ padding: 16, fontSize: 12, color: 'var(--err)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>couldn&apos;t load changes</span>
              <button className="km-btn km-btn--ghost km-btn--sm" onClick={() => mutate()}>
                retry
              </button>
            </div>
          ) : !data ? (
            <div className="km-mono" style={{ padding: 16, fontSize: 12, color: 'var(--fg-3)' }}>loading…</div>
          ) : changeSets.length === 0 ? (
            <div className="km-mono" style={{ padding: 16, fontSize: 12, color: 'var(--fg-3)' }}>no change sets</div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {changeSets.map((cs) => (
                <li key={cs.id} style={{ borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}>
                  <Link
                    href={`/changes/${cs.id}`}
                    style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', textDecoration: 'none', color: 'var(--fg-1)' }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cs.summary ?? '(no summary)'}
                    </span>
                    <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>{cs.itemCount} items</span>
                    <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>{formatAge(cs.createdAt)}</span>
                    <Chip tone={STATUS_TONE[cs.status]}>{cs.status}</Chip>
                  </Link>
                  {cs.hudSessionId && cs.hudSessionTitle && (
                    <Link
                      href={`/hud/${cs.hudSessionId}`}
                      className="km-mono"
                      style={{ fontSize: 10, color: 'var(--accent)', padding: '0 16px', flexShrink: 0 }}
                    >
                      {cs.hudSessionTitle}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
