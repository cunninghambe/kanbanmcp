'use client'

import Link from 'next/link'
import { AlertTriangle, Clock, Activity, GitPullRequestArrow } from 'lucide-react'
import styles from '../hud.module.css'

type PertinentCard = { id: string; title: string; priority: string; columnName: string; ageDays: number }
type SessionMovement = { cardId: string; cardTitle: string; fromColumn: string | null; toColumn: string; movedAt: string }
type Pertinent = {
  board: { id: string; name: string } | null
  overdue: PertinentCard[]
  stalled: PertinentCard[]
  dueSoon: PertinentCard[]
  movedThisSession: SessionMovement[]
  counts: { overdue: number; stalled: number; aging: number; total: number; dueSoon: number; movedThisSession: number }
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
  const counts = pertinent?.counts ?? { overdue: 0, stalled: 0, aging: 0, total: 0, dueSoon: 0, movedThisSession: 0 }

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
        <Stat icon={<GitPullRequestArrow size={12} />} label="proposals" value={pending} tone={pending ? 'accent' : 'default'} href="/changes" />
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
      {pertinent && pertinent.dueSoon.length > 0 && (
        <CardGroup title="due this week" tone="accent" cards={pertinent.dueSoon} boardId={boardId} />
      )}
      {pertinent && pertinent.movedThisSession.length > 0 && (
        <MovementGroup movements={pertinent.movedThisSession} boardId={boardId} />
      )}
      {pertinent &&
        boardId &&
        pertinent.overdue.length === 0 &&
        pertinent.stalled.length === 0 &&
        pertinent.dueSoon.length === 0 &&
        pertinent.movedThisSession.length === 0 && (
          <p className="km-mono" style={{ fontSize: 10, color: 'var(--ok)' }}>● nothing needs attention</p>
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
  href,
}: {
  icon: React.ReactNode
  label: string
  value: number
  tone: 'err' | 'warn' | 'ok' | 'accent' | 'default'
  href?: string
}) {
  const color =
    tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : tone === 'ok' ? 'var(--ok)' : tone === 'accent' ? 'var(--accent)' : 'var(--fg-0)'
  const content = (
    <>
      <span className="km-eyebrow" style={{ fontSize: 9, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--fg-3)' }}>
        <span style={{ color }}>{icon}</span>
        {label}
      </span>
      <span className={styles.statValue} style={{ color }}>
        {String(value).padStart(2, '0')}
      </span>
    </>
  )
  if (href) {
    return (
      <Link href={href} className={styles.stat} style={{ textDecoration: 'none', color: 'inherit' }} aria-label={`${label}: ${value}. View changes.`}>
        {content}
      </Link>
    )
  }
  return <div className={styles.stat}>{content}</div>
}

/** Deep-links a rail row to the card's modal on its board. */
function cardHref(boardId: string, cardId: string): string {
  return `/board/${boardId}?card=${cardId}`
}

/**
 * Shared header + capped-list + link-or-div shell for the rail's card and
 * movement groups. Row content is supplied per-group via `renderRow`; only
 * the key/deep-link id and the row markup differ between groups.
 */
function Group<T>({
  title,
  titleColor,
  items,
  boardId,
  keyFor,
  cardIdFor,
  renderRow,
}: {
  title: string
  titleColor: string
  items: T[]
  boardId: string | null
  keyFor: (item: T) => string
  cardIdFor: (item: T) => string
  renderRow: (item: T) => React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="km-eyebrow" style={{ fontSize: 9, color: titleColor }}>
        {title} · {items.length}
      </span>
      {items.slice(0, 6).map((item) => {
        const key = keyFor(item)
        const row = renderRow(item)
        return boardId ? (
          <Link key={key} href={cardHref(boardId, cardIdFor(item))} className={styles.pcard}>
            {row}
          </Link>
        ) : (
          <div key={key} className={styles.pcard}>
            {row}
          </div>
        )
      })}
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
  tone: 'err' | 'warn' | 'accent'
  cards: PertinentCard[]
  boardId: string | null
}) {
  return (
    <Group
      title={title}
      titleColor={tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : 'var(--accent)'}
      items={cards}
      boardId={boardId}
      keyFor={(c) => c.id}
      cardIdFor={(c) => c.id}
      renderRow={(c) => (
        <>
          <span className={styles.pcard__title}>{c.title}</span>
          <span className={styles.pcard__tag}>{c.ageDays}d</span>
        </>
      )}
    />
  )
}

function MovementGroup({
  movements,
  boardId,
}: {
  movements: SessionMovement[]
  boardId: string | null
}) {
  return (
    <Group
      title="moved this session"
      titleColor="var(--accent)"
      items={movements}
      boardId={boardId}
      keyFor={(m) => `${m.cardId}-${m.movedAt}`}
      cardIdFor={(m) => m.cardId}
      renderRow={(m) => (
        <span className={styles.pcard__title}>
          {m.cardTitle}: {m.fromColumn ?? 'new'} → {m.toColumn}
        </span>
      )}
    />
  )
}
