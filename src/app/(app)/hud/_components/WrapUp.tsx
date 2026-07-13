'use client'

import { useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Chip } from '@/components/design/Chip'
import type { Digest, DigestDispatch, DigestStats } from '@/lib/host-hud/digest'
import styles from '../hud.module.css'

type Proposal = { id: string; status: string; summary: string | null; itemCount: number }

const DISPATCH_STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | undefined> = {
  done: 'ok',
  running: 'warn',
  queued: 'warn',
  failed: 'err',
  cancelled: undefined,
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

export function WrapUp({ sessionId }: { sessionId: string }) {
  const { data: digestData } = useSWR<{ digest: Digest }>(`/api/hud/${sessionId}/digest`, fetcher)
  const { data: changesetData } = useSWR<{ changeSets: Proposal[] }>(
    `/api/changesets?hudSessionId=${sessionId}`,
    fetcher
  )
  const [copied, setCopied] = useState(false)

  const digest = digestData?.digest
  const pendingProposals = (changesetData?.changeSets ?? []).filter((c) => c.status === 'pending')

  async function copyDigest() {
    if (!digest) return
    await navigator.clipboard.writeText(digest.markdown)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <div className={styles.sectionHead}>
        <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>
          {'/// wrap-up'}
        </span>
        <button type="button" className="km-btn km-btn--sm" disabled={!digest} onClick={copyDigest}>
          copy digest
        </button>
      </div>
      <span aria-live="polite" className="km-mono" style={{ fontSize: 10, color: 'var(--ok)' }}>
        {copied ? 'copied ✓' : ''}
      </span>

      {digest && <StatsRow stats={digest.stats} />}

      <ProposalsSection proposals={pendingProposals} />

      {digest && <DispatchHistory dispatches={digest.dispatches} />}
    </>
  )
}

function StatsRow({ stats }: { stats: DigestStats }) {
  return (
    <div className={styles.stats} style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
      <Stat
        label="dispatches"
        value={`${stats.answered}/${stats.dispatches}`}
        srLabel={`dispatches: ${stats.answered} of ${stats.dispatches} answered`}
      />
      <Stat
        label="actions"
        value={`${stats.actionsWithCards}/${stats.actions}`}
        srLabel={`actions: ${stats.actionsWithCards} of ${stats.actions} converted to cards`}
      />
      <Stat label="decisions" value={String(stats.decisions)} srLabel={`decisions: ${stats.decisions}`} />
      <Stat
        label="agenda"
        value={`${stats.agendaDone}/${stats.agendaTotal}`}
        srLabel={`agenda: ${stats.agendaDone} of ${stats.agendaTotal} done`}
      />
      <Stat
        label="proposals pending"
        value={String(stats.proposalsPending)}
        srLabel={`proposals pending: ${stats.proposalsPending}`}
      />
    </div>
  )
}

function Stat({ label, value, srLabel }: { label: string; value: string; srLabel: string }) {
  return (
    <div className={styles.stat} role="group" aria-label={srLabel}>
      <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
        {label}
      </span>
      <span className={styles.statValue}>{value}</span>
    </div>
  )
}

function ProposalsSection({ proposals }: { proposals: Proposal[] }) {
  return (
    <div className={styles.mpSection}>
      <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
        pending proposals
      </span>

      {proposals.length === 0 && <p className={styles.mpHint}>no pending proposals.</p>}

      {proposals.map((p) => (
        <Link key={p.id} href={`/changes/${p.id}`} className={styles.pcard}>
          <span className={styles.pcard__title}>{p.summary ?? '(no summary)'}</span>
          <span className={styles.pcard__tag}>{p.itemCount} items</span>
        </Link>
      ))}
    </div>
  )
}

function DispatchHistory({ dispatches }: { dispatches: DigestDispatch[] }) {
  return (
    <div className={styles.mpSection}>
      <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
        dispatch history
      </span>

      {dispatches.length === 0 && <p className={styles.mpHint}>no agent dispatches this session.</p>}

      {dispatches.map((d, i) => (
        <div key={`${d.target}-${i}`} className={styles.mpRow}>
          <div className={styles.mpRowHead}>
            <span className={styles.mpKind}>{d.target}</span>
            <span className={styles.mpRowText}>{d.question}</span>
            <Chip tone={DISPATCH_STATUS_TONE[d.status]}>{d.status}</Chip>
          </div>
        </div>
      ))}
    </div>
  )
}
