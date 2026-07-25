'use client'

import Link from 'next/link'
import useSWR from 'swr'
import { sanitizeCitationUrl } from '@/lib/host-hud/dispatch'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// Anyone who can email the user can raise a nudge (subjects matching the urgent
// hard rules), so the banner must stay a fixed size no matter how many arrive —
// otherwise a flood pushes the whole app below the fold and each row costs a
// click to clear.
const MAX_VISIBLE = 5

interface Nudge {
  id: string
  title: string
  summary: string | null
  fromLabel: string | null
  permalink: string | null
  cardId: string | null
  boardId: string | null
  createdAt: string
}

/**
 * Sticky urgent-mail banner, mounted once above `{children}` in the app
 * shell. Polls /api/nudges every 30s and renders nothing when there are no
 * pending nudges or when polling fails — the app must never degrade because
 * a background poll errored.
 */
export function NudgeBanner() {
  const { data, mutate } = useSWR<{ nudges: Nudge[] }>('/api/nudges', fetcher, {
    refreshInterval: 30_000,
    shouldRetryOnError: false,
  })

  const nudges = data?.nudges ?? []
  if (nudges.length === 0) return null

  async function ack(id: string) {
    // Optimistic removal — the banner should never wait on the network to feel responsive.
    mutate({ nudges: nudges.filter((n) => n.id !== id) }, false)
    try {
      await fetch(`/api/nudges/${id}/ack`, { method: 'POST' })
    } finally {
      mutate()
    }
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 60,
        background: 'var(--accent-tint)',
        borderBottom: '1px solid var(--accent)',
      }}
    >
      <style>{`
        @keyframes km-nudge-ping {
          0% { transform: scale(1); opacity: 0.7; }
          70%, 100% { transform: scale(2.8); opacity: 0; }
        }
      `}</style>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          className="km-eyebrow"
          style={{ fontSize: 9, color: 'var(--accent)', padding: '6px 16px 0' }}
        >
          {'/// urgent'}
        </div>
        {nudges.slice(0, MAX_VISIBLE).map((n) => (
          <div
            key={n.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 16px',
              minWidth: 0,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: 9999,
                background: 'var(--accent)',
                position: 'relative',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  content: '""',
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 9999,
                  background: 'var(--accent)',
                  animation: 'km-nudge-ping 1.8s var(--ease-out) infinite',
                }}
              />
            </span>
            {/* The sender label and title are quoted from an untrusted email, so
                they must not look like mhud's own voice: an "ext" chip and muted
                weight keep a sender called "mhud" from impersonating app chrome. */}
            <span className="km-chip km-mono" style={{ flexShrink: 0, fontSize: 9 }}>
              ext
            </span>
            <span style={{ minWidth: 0, flex: 1, fontSize: 13, color: 'var(--fg-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {n.fromLabel && <span style={{ color: 'var(--fg-2)' }}>{n.fromLabel}: </span>}
              {n.title}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {n.boardId && (
                <Link href={`/board/${n.boardId}`} className="km-btn km-btn--ghost km-btn--sm km-mono">
                  open card
                </Link>
              )}
              {sanitizeCitationUrl(n.permalink) && (
                <a
                  href={sanitizeCitationUrl(n.permalink)}
                  target="_blank"
                  rel="noreferrer"
                  className="km-btn km-btn--ghost km-btn--sm km-mono"
                >
                  gmail
                </a>
              )}
              <button
                type="button"
                onClick={() => ack(n.id)}
                className="km-btn km-btn--sm km-mono"
              >
                ack
              </button>
            </span>
          </div>
        ))}
        {nudges.length > MAX_VISIBLE && (
          <div className="km-mono" style={{ fontSize: 10, color: 'var(--fg-2)', padding: '2px 16px 6px' }}>
            +{nudges.length - MAX_VISIBLE} more urgent
          </div>
        )}
      </div>
    </div>
  )
}
