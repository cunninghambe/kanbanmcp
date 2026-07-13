'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Chip } from '@/components/design/Chip'
import { STATUS_TONE } from './DispatchCard'
import type { Digest, DigestDispatch, DigestStats } from '@/lib/host-hud/digest'
import styles from '../hud.module.css'

type Proposal = { id: string; status: string; summary: string | null; itemCount: number }

const COPIED_FLASH_MS = 2000

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

export function WrapUp({ sessionId }: { sessionId: string }) {
  const {
    data: digestData,
    error: digestError,
    mutate: mutateDigest,
  } = useSWR<{ digest: Digest }>(`/api/hud/${sessionId}/digest`, fetcher)
  const { data: changesetData } = useSWR<{ changeSets: Proposal[] }>(
    `/api/changesets?hudSessionId=${sessionId}`,
    fetcher
  )
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
  }, [])

  const digest = digestData?.digest
  const pendingProposals = (changesetData?.changeSets ?? []).filter((c) => c.status === 'pending')
  const proposalFrom = encodeURIComponent(`/hud/${sessionId}`)

  async function copyDigest() {
    if (!digest) return
    await navigator.clipboard.writeText(digest.markdown)
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FLASH_MS)
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

      {digestError && <DigestErrorState onRetry={() => mutateDigest()} />}
      {!digestError && !digest && <p className={styles.mpHint}>loading digest…</p>}
      {digest && <StatsRow stats={digest.stats} />}

      <ProposalsSection proposals={pendingProposals} from={proposalFrom} />

      {digest && <DispatchHistory dispatches={digest.dispatches} />}
    </>
  )
}

function DigestErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="alert" className={styles.mpRowError}>
      couldn&apos;t load digest —{' '}
      <button type="button" className="km-btn km-btn--sm" onClick={onRetry}>
        retry
      </button>
    </p>
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

function ProposalsSection({ proposals, from }: { proposals: Proposal[]; from: string }) {
  return (
    <div className={styles.mpSection}>
      <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
        pending proposals
      </span>

      {proposals.length === 0 && <p className={styles.mpHint}>no pending proposals.</p>}

      {proposals.map((p) => (
        <Link key={p.id} href={`/changes/${p.id}?from=${from}`} className={styles.pcard}>
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
            <Chip tone={STATUS_TONE[d.status]}>{d.status}</Chip>
          </div>
        </div>
      ))}
    </div>
  )
}
