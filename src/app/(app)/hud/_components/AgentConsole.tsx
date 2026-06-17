'use client'

import { useState } from 'react'
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
  const [target, setTarget] = useState<Target>('board')
  const [question, setQuestion] = useState('')

  function submit() {
    const q = question.trim()
    if (!q || !live || busy) return
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
          return (
            <button
              key={t.key}
              type="button"
              className={styles.seg}
              aria-pressed={target === t.key}
              disabled={!live}
              onClick={() => setTarget(t.key)}
            >
              <Icon size={12} />
              {t.label}
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
