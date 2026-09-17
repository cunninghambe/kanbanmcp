'use client'

import { useEffect, useState } from 'react'

// Spec: docs/specs/mhud-today-planner.md §7.3 "Integrations page" / §7.4.
// Mirrors IntegrationRow's (Google) state machine against /api/me/slack/status.

type SlackStatusResponse =
  | { connected: false }
  | {
      connected: true
      teamName: string
      teamId: string
      slackUserId: string
      scopes: string[]
      lastUsedAt: string | null
    }

type View =
  | { phase: 'loading' }
  | { phase: 'disconnected' }
  | { phase: 'connected'; teamName: string }
  | { phase: 'error'; message: string }

export function SlackIntegrationRow() {
  const [view, setView] = useState<View>({ phase: 'loading' })
  const [fetchKey, setFetchKey] = useState(0)
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch('/api/me/slack/status')
        if (cancelled) return
        if (!res.ok) throw new Error(`Status ${res.status}`)
        const data = (await res.json()) as SlackStatusResponse
        if (cancelled) return
        setView(
          data.connected
            ? { phase: 'connected', teamName: data.teamName }
            : { phase: 'disconnected' }
        )
      } catch (err) {
        if (!cancelled) {
          setView({
            phase: 'error',
            message: err instanceof Error ? err.message : 'Failed to load status',
          })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [fetchKey])

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      const res = await fetch('/api/me/slack/disconnect', { method: 'DELETE' })
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
        padding: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        marginTop: 12,
      }}
      aria-live="polite"
    >
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
          Slack
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
              Connected to{' '}
              <span style={{ color: 'var(--fg-0)', fontWeight: 500 }}>{view.teamName}</span>
            </span>
          )}
          {view.phase === 'error' && <span style={{ color: 'var(--err)' }}>{view.message}</span>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        {view.phase === 'disconnected' && (
          <a href="/api/me/slack/connect" className="km-btn" aria-label="Connect Slack workspace">
            Connect Slack
          </a>
        )}
        {view.phase === 'connected' && (
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            disabled={disconnecting}
            className="km-btn"
            aria-label="Disconnect Slack workspace"
          >
            {disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </button>
        )}
        {view.phase === 'error' && (
          <button type="button" onClick={handleRetry} className="km-btn">
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
