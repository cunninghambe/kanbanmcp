'use client'

import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import { LayoutGrid, HardDrive, Mail, Hash, X, ArrowRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Chip } from '@/components/design/Chip'
import styles from '../hud.module.css'

export type Citation = { kind: string; id?: string; title?: string; url?: string; quote?: string }
export type Dispatch = {
  id: string
  target: 'board' | 'drive' | 'email' | 'slack'
  question: string
  status: string
  answer: string | null
  citations: Citation[] | null
  confidence: number | null
  proposedChangeSetId: string | null
  error: string | null
  createdAt: string
}

const TARGET_ICON: Record<Dispatch['target'], LucideIcon> = {
  board: LayoutGrid,
  drive: HardDrive,
  email: Mail,
  slack: Hash,
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | undefined> = {
  done: 'ok',
  running: 'warn',
  queued: 'warn',
  failed: 'err',
  cancelled: undefined,
}

export function DispatchCard({
  dispatch: d,
  hudId,
  onCancel,
}: {
  dispatch: Dispatch
  hudId: string
  onCancel: (id: string) => void
}) {
  const Icon = TARGET_ICON[d.target]
  const active = d.status === 'running' || d.status === 'queued'

  return (
    <article className={`${styles.dcard} ${active ? styles['dcard--active'] : ''}`}>
      {d.status === 'running' && <div className={styles.scan} />}
      <header className={styles.dhead}>
        <span className={styles.dicon}>
          <Icon size={13} />
        </span>
        <span className={styles.dquestion}>{d.question}</span>
        <Chip tone={STATUS_TONE[d.status]} dot={active}>
          {d.status}
        </Chip>
        {active && (
          <button
            className="km-btn km-btn--ghost km-btn--sm"
            onClick={() => onCancel(d.id)}
            aria-label="Cancel dispatch"
            style={{ padding: '2px 6px' }}
          >
            <X size={12} />
          </button>
        )}
      </header>

      <div className={styles.dbody}>
        {d.status === 'done' && d.answer ? (
          <div className={styles.prose}>
            <ReactMarkdown>{d.answer}</ReactMarkdown>
          </div>
        ) : d.status === 'failed' ? (
          <div className="km-mono" style={{ fontSize: 11, color: 'var(--err)' }}>
            {d.error ?? 'dispatch failed'}
          </div>
        ) : d.status === 'cancelled' ? (
          <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            cancelled by chair
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className={styles.shimmer} style={{ width: '92%' }} />
            <div className={styles.shimmer} style={{ width: '76%' }} />
            <div className={styles.shimmer} style={{ width: '84%' }} />
            <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 2 }}>
              {d.status === 'queued' ? 'queued — agent will pick this up…' : 'agent is gathering the answer…'}
            </span>
          </div>
        )}

        {d.citations && d.citations.length > 0 && (
          <div className={styles.cites}>
            <span className="km-eyebrow" style={{ fontSize: 9 }}>
              evidence · {d.citations.length}
            </span>
            {d.citations.map((c, i) => (
              <div key={i} className={styles.cite}>
                <span style={{ color: 'var(--fg-3)' }}>[{c.kind}]</span>
                <span>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.title ?? c.url}
                    </a>
                  ) : (
                    c.title ?? c.id ?? '—'
                  )}
                  {c.quote ? <span style={{ color: 'var(--fg-3)' }}> — “{c.quote}”</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}

        {typeof d.confidence === 'number' && d.status === 'done' && (
          <div className={styles.meter}>
            <span className="km-eyebrow" style={{ fontSize: 9 }}>
              confidence
            </span>
            <span className={styles.meterTrack}>
              <span className={styles.meterFill} style={{ right: `${100 - d.confidence * 100}%` }} />
            </span>
            <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-2)' }}>
              {(d.confidence * 100).toFixed(0)}%
            </span>
          </div>
        )}

        {d.proposedChangeSetId && (
          <div className={styles.callout}>
            <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--accent)' }}>
              proposed change
            </span>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--fg-2)' }}>
              not applied — awaiting your approval
            </span>
            <Link href={`/changes/${d.proposedChangeSetId}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              review <ArrowRight size={12} />
            </Link>
          </div>
        )}
      </div>
    </article>
  )
}
