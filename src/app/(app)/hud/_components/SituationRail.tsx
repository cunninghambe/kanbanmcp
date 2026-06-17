'use client'

import Link from 'next/link'
import { AlertTriangle, Clock, Activity, GitPullRequestArrow } from 'lucide-react'
import styles from '../hud.module.css'

type PertinentCard = { id: string; title: string; priority: string; columnName: string; ageDays: number }
type Pertinent = {
  board: { id: string; name: string } | null
  overdue: PertinentCard[]
  stalled: PertinentCard[]
  counts: { overdue: number; stalled: number; aging: number; total: number }
}

export function SituationRail({
  pertinent,
  inFlight,
  pending,
  boardId,
}: {
  pertinent: Pertinent | undefined
  inFlight: number
  pending: number
  boardId: string | null
}) {
  const counts = pertinent?.counts ?? { overdue: 0, stalled: 0, aging: 0, total: 0 }

  return (
    <>
      <div className={styles.sectionHead}>
        <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>
          {'/// situation'}
        </span>
        {boardId && (
          <Link href={`/board/${boardId}`} className="km-mono" style={{ fontSize: 10, color: 'var(--accent)' }}>
            open board →
          </Link>
        )}
      </div>

      <div className={styles.stats}>
        <Stat icon={<AlertTriangle size={12} />} label="overdue" value={counts.overdue} tone="err" />
        <Stat icon={<Clock size={12} />} label="stalled" value={counts.stalled} tone="warn" />
        <Stat icon={<Activity size={12} />} label="agents live" value={inFlight} tone={inFlight ? 'ok' : 'default'} />
        <Stat icon={<GitPullRequestArrow size={12} />} label="proposals" value={pending} tone={pending ? 'accent' : 'default'} />
      </div>

      {!boardId && (
        <p className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', lineHeight: 1.5 }}>
          no board attached — situational metrics need a board.
        </p>
      )}

      {pertinent && pertinent.overdue.length > 0 && (
        <CardGroup title="overdue" tone="err" cards={pertinent.overdue} boardId={boardId} />
      )}
      {pertinent && pertinent.stalled.length > 0 && (
        <CardGroup title="stalled" tone="warn" cards={pertinent.stalled} boardId={boardId} />
      )}
      {pertinent && boardId && pertinent.overdue.length === 0 && pertinent.stalled.length === 0 && (
        <p className="km-mono" style={{ fontSize: 10, color: 'var(--ok)' }}>● nothing overdue or stalled</p>
      )}

      <p className="km-mono" style={{ fontSize: 9, color: 'var(--fg-3)', lineHeight: 1.5, marginTop: 'auto', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        agents never change the board live. anything they suggest waits for your approval.
      </p>
    </>
  )
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: number
  tone: 'err' | 'warn' | 'ok' | 'accent' | 'default'
}) {
  const color =
    tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : tone === 'ok' ? 'var(--ok)' : tone === 'accent' ? 'var(--accent)' : 'var(--fg-0)'
  return (
    <div className={styles.stat}>
      <span className="km-eyebrow" style={{ fontSize: 9, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--fg-3)' }}>
        <span style={{ color }}>{icon}</span>
        {label}
      </span>
      <span className={styles.statValue} style={{ color }}>
        {String(value).padStart(2, '0')}
      </span>
    </div>
  )
}

function CardGroup({
  title,
  tone,
  cards,
  boardId,
}: {
  title: string
  tone: 'err' | 'warn'
  cards: PertinentCard[]
  boardId: string | null
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="km-eyebrow" style={{ fontSize: 9, color: tone === 'err' ? 'var(--err)' : 'var(--warn)' }}>
        {title} · {cards.length}
      </span>
      {cards.slice(0, 6).map((c) => {
        const inner = (
          <>
            <span className={styles.pcard__title}>{c.title}</span>
            <span className={styles.pcard__tag}>{c.ageDays}d</span>
          </>
        )
        return boardId ? (
          <Link key={c.id} href={`/board/${boardId}`} className={styles.pcard}>
            {inner}
          </Link>
        ) : (
          <div key={c.id} className={styles.pcard}>
            {inner}
          </div>
        )
      })}
    </div>
  )
}
