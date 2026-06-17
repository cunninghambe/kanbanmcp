'use client'

import { use, useEffect, useState } from 'react'
import useSWR from 'swr'
import { RadioTower } from 'lucide-react'
import { Chip } from '@/components/design/Chip'
import { useHudStream } from '@/hooks/useHudStream'
import { AgentConsole } from '../_components/AgentConsole'
import type { Target } from '../_components/AgentConsole'
import { DispatchCard } from '../_components/DispatchCard'
import type { Dispatch } from '../_components/DispatchCard'
import { SituationRail } from '../_components/SituationRail'
import styles from '../hud.module.css'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

const swrOpts = (refreshInterval: number) => ({
  refreshInterval,
  shouldRetryOnError: (err: Error) => !['401', '403', '404'].includes(err.message),
})

type HudSession = { id: string; title: string; status: string; boardId: string | null; startedAt: string }

function elapsed(fromISO: string | undefined): string {
  if (!fromISO) return '00:00'
  const s = Math.max(0, Math.floor((Date.now() - new Date(fromISO).getTime()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

export default function HudSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, mutate } = useSWR<{ session: HudSession; dispatches: Dispatch[] }>(`/api/hud/${id}`, fetcher, swrOpts(4000))
  const { data: pertinent } = useSWR(`/api/hud/${id}/pertinent`, fetcher, swrOpts(15000))
  const { data: changeData } = useSWR<{ changeSets: { id: string; status: string }[] }>(
    `/api/changesets?hudSessionId=${id}`,
    fetcher,
    swrOpts(5000)
  )

  const session = data?.session

  useHudStream({ sessionId: id, enabled: !!session })

  const [busy, setBusy] = useState(false)
  const [dispatchError, setDispatchError] = useState<string | null>(null)
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const dispatches = data?.dispatches ?? []
  const live = session?.status === 'live'
  const inFlight = dispatches.filter((d) => d.status === 'running' || d.status === 'queued').length
  const pending = (changeData?.changeSets ?? []).filter((c) => c.status === 'pending').length

  async function dispatch(target: Target, question: string) {
    setBusy(true)
    setDispatchError(null)
    try {
      const res = await fetch(`/api/hud/${id}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, question }),
      })
      if (res.ok) {
        mutate()
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setDispatchError(body.error ?? `Dispatch failed (${res.status})`)
      }
    } catch {
      setDispatchError('Dispatch failed — network error')
    } finally {
      setBusy(false)
    }
  }

  async function cancel(dispatchId: string) {
    await fetch(`/api/hud/dispatch/${dispatchId}/cancel`, { method: 'POST' })
    mutate()
  }

  async function endSession() {
    await fetch(`/api/hud/${id}/end`, { method: 'POST' })
    mutate()
  }

  return (
    <div className={styles.shell}>
      {/* mission-control header */}
      <header
        style={{
          height: 56,
          flexShrink: 0,
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg-1)',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '0 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {live ? <span className={styles.pulse} /> : <RadioTower size={14} style={{ color: 'var(--fg-3)' }} />}
          <div style={{ minWidth: 0 }}>
            <div className="km-mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-3)' }}>
              host meeting hud
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--fg-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session?.title ?? 'HUD'}
            </div>
          </div>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {live && (
            <span className="km-mono" style={{ fontSize: 13, color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
              {elapsed(session?.startedAt)}
            </span>
          )}
          <Chip tone={live ? 'ok' : undefined} dot={live}>
            {session?.status ?? '…'}
          </Chip>
          {live && (
            <button className="km-btn km-btn--sm" onClick={endSession}>
              end session
            </button>
          )}
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.rail}>
          <SituationRail pertinent={pertinent} inFlight={inFlight} pending={pending} boardId={session?.boardId ?? null} />
        </aside>

        <main className={styles.main}>
          <AgentConsole live={!!live} busy={busy} onDispatch={dispatch} />

          {dispatchError && (
            <div role="alert" className="km-mono" style={{ margin: '8px 0', fontSize: 11, color: 'var(--danger, #f87171)' }}>
              {dispatchError}
            </div>
          )}

          {dispatches.length === 0 ? (
            <div className={styles.empty}>
              <RadioTower size={22} style={{ color: 'var(--fg-3)' }} />
              <div className="km-eyebrow" style={{ fontSize: 10 }}>no agents dispatched</div>
              <p className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)', maxWidth: 340, lineHeight: 1.5 }}>
                Ask a question above and an agent will fetch the answer while you stay in the meeting.
              </p>
            </div>
          ) : (
            <div className={styles.fleet}>
              {dispatches.map((d) => (
                <DispatchCard key={d.id} dispatch={d} hudId={id} onCancel={cancel} />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
