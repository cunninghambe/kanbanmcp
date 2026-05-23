'use client'

import { useEffect, useRef, useState } from 'react'

// ---- Types ----------------------------------------------------------------

type GoogleStatusResponse =
  | { connected: false }
  | {
      connected: true
      email: string
      scopes: string[]
      lastUsedAt: string | null
      expired: boolean
    }

type View =
  | { phase: 'loading' }
  | { phase: 'disconnected' }
  | { phase: 'connected'; email: string; lastUsedAt: string | null; scopes: string[] }
  | { phase: 'expired'; email: string }
  | { phase: 'error'; message: string }

interface Props {
  integration: 'google'
}

// ---- Helpers ---------------------------------------------------------------

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  const seconds = Math.round(diff / 1000)
  if (seconds < 60) return fmt.format(-seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return fmt.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return fmt.format(-hours, 'hour')
  const days = Math.round(hours / 24)
  return fmt.format(-days, 'day')
}

function statusToView(data: GoogleStatusResponse): View {
  if (!data.connected) return { phase: 'disconnected' }
  if (data.expired) return { phase: 'expired', email: data.email }
  return {
    phase: 'connected',
    email: data.email,
    lastUsedAt: data.lastUsedAt,
    scopes: data.scopes,
  }
}

// ---- Component -------------------------------------------------------------

export function IntegrationRow({ integration: _integration }: Props) {
  const [view, setView] = useState<View>({ phase: 'loading' })
  const [fetchKey, setFetchKey] = useState(0)
  const [disconnecting, setDisconnecting] = useState(false)
  const connectBtnRef = useRef<HTMLAnchorElement>(null)
  const prevPhaseRef = useRef<string>('loading')

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch('/api/me/google/status')
        if (cancelled) return
        if (!res.ok) throw new Error(`Status ${res.status}`)
        const data = (await res.json()) as GoogleStatusResponse
        if (!cancelled) setView(statusToView(data))
      } catch (err) {
        if (!cancelled) {
          setView({ phase: 'error', message: err instanceof Error ? err.message : 'Failed to load status' })
        }
      }
    }

    void load()
    return () => { cancelled = true }
  }, [fetchKey])

  // Move focus to Connect button after a disconnect transition
  useEffect(() => {
    if (prevPhaseRef.current !== 'disconnected' && view.phase === 'disconnected') {
      connectBtnRef.current?.focus()
    }
    prevPhaseRef.current = view.phase
  }, [view.phase])

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      const res = await fetch('/api/me/google/disconnect', { method: 'DELETE' })
      if (res.status === 204) {
        setView({ phase: 'disconnected' })
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setView({ phase: 'error', message: body.error ?? `Disconnect failed (${res.status})` })
      }
    } catch (err) {
      setView({ phase: 'error', message: err instanceof Error ? err.message : 'Disconnect failed' })
    } finally {
      setDisconnecting(false)
    }
  }

  function handleRetry() {
    setView({ phase: 'loading' })
    setFetchKey((k) => k + 1)
  }

  return (
    <div
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        padding: '20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}
      aria-live="polite"
    >
      {/* Left: integration label + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          className="km-mono"
          style={{
            fontSize: 11,
            color: 'var(--fg-3)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            width: 60,
          }}
        >
          Google
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-1)' }}>
          {view.phase === 'loading' && (
            <span style={{ color: 'var(--fg-3)' }}>Checking connection status...</span>
          )}
          {view.phase === 'disconnected' && (
            <span style={{ color: 'var(--fg-3)' }}>Not connected</span>
          )}
          {view.phase === 'connected' && (
            <span>
              Connected as{' '}
              <span style={{ color: 'var(--fg-0)', fontWeight: 500 }}>{view.email}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>
                Last used:{' '}
                {view.lastUsedAt ? formatRelative(view.lastUsedAt) : 'Never'}
              </span>
            </span>
          )}
          {view.phase === 'expired' && (
            <span>
              <span style={{ color: 'var(--warn)', fontWeight: 500 }}>Connection expired</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>
                Reconnect to keep AI reviews working.
              </span>
            </span>
          )}
          {view.phase === 'error' && (
            <span style={{ color: 'var(--err)' }}>{view.message}</span>
          )}
        </div>
      </div>

      {/* Right: action button */}
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        {view.phase === 'disconnected' && (
          <a
            ref={connectBtnRef}
            href="/api/me/google/connect"
            className="km-btn"
            aria-label="Connect Google account"
          >
            Connect Google
          </a>
        )}
        {view.phase === 'connected' && (
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="km-btn"
            aria-label="Disconnect Google account"
          >
            {disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </button>
        )}
        {view.phase === 'expired' && (
          <a
            href="/api/me/google/connect"
            className="km-btn km-btn--primary"
            aria-label="Reconnect Google account"
          >
            Reconnect Google
          </a>
        )}
        {view.phase === 'error' && (
          <button
            type="button"
            onClick={handleRetry}
            className="km-btn"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
