'use client'

import { useState } from 'react'
import type { CSSProperties } from 'react'
import useSWR from 'swr'
import { LayoutGrid, HardDrive, Mail, Hash, Send } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import styles from '../hud.module.css'

export type Target = 'board' | 'drive' | 'email' | 'slack'

const TARGETS: { key: Target; label: string; icon: LucideIcon }[] = [
  { key: 'board', label: 'board', icon: LayoutGrid },
  { key: 'drive', label: 'drive', icon: HardDrive },
  { key: 'email', label: 'email', icon: Mail },
  { key: 'slack', label: 'slack', icon: Hash },
]

const ALL_TARGETS: Target[] = TARGETS.map((t) => t.key)

const configFetcher = (url: string): Promise<{ enabledTargets: Target[] }> =>
  fetch(url).then((r) => (r.ok ? r.json() : { enabledTargets: ALL_TARGETS }))

// Visually hidden but announced by screen readers (no sr-only utility in this app).
const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

const SUGGESTIONS: Record<Target, string[]> = {
  board: ['What is overdue and stalled here?', 'Which cards moved since last week?', 'Summarise open work by assignee.'],
  drive: ['Find the latest handover doc.', 'What does the contract say about timelines?', 'Locate the Q3 plan.'],
  email: ['Did we email the lawyer this week?', 'Any replies on the budget thread?'],
  slack: ['What was decided in #ops today?', 'Catch me up on the launch channel.'],
}

export function AgentConsole({
  live,
  busy,
  onDispatch,
}: {
  live: boolean
  busy: boolean
  onDispatch: (target: Target, question: string) => void
}) {
  const [selectedTarget, setSelectedTarget] = useState<Target>('board')
  const [question, setQuestion] = useState('')

  // Which targets this deployment's external agent can actually answer. Until the
  // config loads we optimistically allow all four (the server still enforces).
  const { data: config } = useSWR<{ enabledTargets: Target[] }>('/api/hud/config', configFetcher)
  const enabledTargets = config?.enabledTargets ?? ALL_TARGETS

  // Derive the effective target during render (no setState-in-effect): if the
  // selected one is disabled, fall back to the first enabled target (prefer board)
  // so the chair never has a disabled target selected.
  const target: Target = enabledTargets.includes(selectedTarget)
    ? selectedTarget
    : (enabledTargets.includes('board') ? 'board' : enabledTargets[0]) ?? 'board'

  function submit() {
    const q = question.trim()
    if (!q || !live || busy || !enabledTargets.includes(target)) return
    onDispatch(target, q)
    setQuestion('')
  }

  return (
    <div className={styles.console}>
      <div className={styles.consoleHead}>
        <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>
          {'/// dispatch agent'}
        </span>
        <span className="km-mono" style={{ fontSize: 9, color: 'var(--fg-3)', marginLeft: 'auto' }}>
          read-only · answers only
        </span>
      </div>

      <div className={styles.segs}>
        {TARGETS.map((t) => {
          const Icon = t.icon
          const available = enabledTargets.includes(t.key)
          return (
            <button
              key={t.key}
              type="button"
              className={styles.seg}
              aria-pressed={target === t.key}
              // Session-ended keeps the native disabled (whole console shuts off);
              // capability gating uses aria-disabled so the chip stays focusable
              // and screen readers can reach the hidden reason below.
              disabled={!live}
              aria-disabled={!live || !available}
              title={available ? undefined : `${t.label} is not enabled for this deployment`}
              onClick={() => {
                if (available) setSelectedTarget(t.key)
              }}
            >
              <Icon size={12} />
              {t.label}
              {!available && <span style={SR_ONLY}>(not configured for this deployment)</span>}
            </button>
          )
        })}
      </div>

      <textarea
        className={styles.prompt}
        placeholder={live ? `Ask the ${target} agent anything…` : 'Session ended — dispatch disabled'}
        value={question}
        disabled={!live}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        rows={2}
      />

      <div style={{ padding: '0 12px 10px' }}>
        <div className={styles.suggests}>
          {SUGGESTIONS[target].map((s) => (
            <button key={s} type="button" className={styles.suggest} disabled={!live} onClick={() => setQuestion(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.consoleFoot}>
        <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
          <span className={styles.kbd}>⌘</span> <span className={styles.kbd}>↵</span> to dispatch
        </span>
        <button className="km-btn km-btn--primary km-btn--sm" disabled={!live || busy || !question.trim()} onClick={submit}>
          <Send size={12} /> dispatch
        </button>
      </div>
    </div>
  )
}
