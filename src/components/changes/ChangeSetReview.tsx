'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { Topbar } from '@/components/design/Topbar'
import { Chip } from '@/components/design/Chip'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

type ChangeItem = {
  id: string
  op: string
  payload: Record<string, unknown>
  display: string
  evidence: { quote?: string } | null
  confidence: number | null
  decision: string
  error: string | null
  appliedAt: string | null
}
type ChangeSet = {
  id: string
  status: string
  summary: string | null
  boardId: string | null
  createdById: string
  items: ChangeItem[]
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | undefined> = {
  applied: 'ok',
  partially_applied: 'warn',
  pending: 'warn',
  rejected: 'err',
  expired: undefined,
}

export function ChangeSetReview({ changeSetId, backHref = '/changes' }: { changeSetId: string; backHref?: string }) {
  const router = useRouter()
  const { data, mutate } = useSWR<{ changeSet: ChangeSet }>(`/api/changesets/${changeSetId}`, fetcher)

  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [applying, setApplying] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const cs = data?.changeSet
  const isPending = cs?.status === 'pending' || cs?.status === 'partially_applied'

  function toggle(itemId: string) {
    setChecked((c) => ({ ...c, [itemId]: !c[itemId] }))
  }

  function checkedItemIds(): string[] {
    if (!cs) return []
    return cs.items.filter((it) => checked[it.id]).map((it) => it.id)
  }

  async function apply() {
    const approvedItemIds = checkedItemIds()
    if (approvedItemIds.length === 0) return
    setApplying(true)
    setResult(null)
    try {
      const res = await fetch(`/api/changesets/${changeSetId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedItemIds }),
      })
      const body = (await res.json().catch(() => ({}))) as { status?: string; failures?: number; error?: string }
      if (!res.ok) {
        setResult(body.error ?? res.statusText)
      } else {
        setResult(`Applied — status: ${body.status}${body.failures ? `, ${body.failures} failed` : ''}`)
        setChecked({})
        mutate()
      }
    } finally {
      setApplying(false)
    }
  }

  async function reject() {
    const itemIds = checkedItemIds()
    if (itemIds.length === 0) return
    setRejecting(true)
    setResult(null)
    try {
      const res = await fetch(`/api/changesets/${changeSetId}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: itemIds.map((itemId) => ({ itemId, decision: 'rejected' })) }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setResult(body.error ?? res.statusText)
      } else {
        setResult(`Rejected ${itemIds.length} item${itemIds.length === 1 ? '' : 's'}`)
        setChecked({})
        mutate()
      }
    } finally {
      setRejecting(false)
    }
  }

  return (
    <>
      <Topbar
        title="Review proposal"
        breadcrumb="// agents propose · humans approve"
        right={
          <button className="km-btn km-btn--ghost km-btn--sm" onClick={() => router.push(backHref)}>
            back
          </button>
        }
      />
      <div style={{ padding: 24, maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!cs ? (
          <div className="km-mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Chip tone={STATUS_TONE[cs.status]}>{cs.status}</Chip>
              <span style={{ fontSize: 14 }}>{cs.summary ?? 'Proposed board changes'}</span>
              <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginLeft: 'auto' }}>
                by {cs.createdById}
              </span>
            </div>

            <section style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
                <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>{'/// proposed ops'}</span>
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {cs.items.map((it) => (
                  <li key={it.id} style={{ borderBottom: '1px solid var(--line)', padding: 14, display: 'flex', gap: 12 }}>
                    {isPending && it.decision === 'pending' && (
                      <input
                        type="checkbox"
                        checked={!!checked[it.id]}
                        onChange={() => toggle(it.id)}
                        aria-label={`select: ${it.display}`}
                        style={{ marginTop: 3 }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Chip tone="accent">{it.op}</Chip>
                        {it.decision !== 'pending' && (
                          <Chip tone={it.decision === 'approved' ? 'ok' : it.decision === 'rejected' ? 'err' : undefined}>
                            {it.decision}
                          </Chip>
                        )}
                        {typeof it.confidence === 'number' && (
                          <span className="km-mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
                            {(it.confidence * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--fg-1)', marginTop: 6 }}>{it.display}</div>
                      <details style={{ marginTop: 6 }}>
                        <summary className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', cursor: 'pointer' }}>
                          raw op
                        </summary>
                        <pre className="km-mono" style={{ fontSize: 11, color: 'var(--fg-2)', marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {JSON.stringify(it.payload, null, 2)}
                        </pre>
                      </details>
                      {it.evidence?.quote && (
                        <div className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>
                          evidence: “{it.evidence.quote}”
                        </div>
                      )}
                      {it.error && (
                        <div className="km-mono" style={{ fontSize: 10, color: 'var(--err)', marginTop: 4 }}>{it.error}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {isPending && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="km-btn km-btn--primary" onClick={apply} disabled={applying || rejecting}>
                  {applying ? 'applying…' : 'apply selected'}
                </button>
                <button className="km-btn km-btn--ghost" onClick={reject} disabled={applying || rejecting}>
                  {rejecting ? 'rejecting…' : 'reject selected'}
                </button>
                <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
                  only checked items are affected — nothing happens to the board otherwise
                </span>
              </div>
            )}
            {result && (
              <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-1)' }}>{result}</div>
            )}
          </>
        )}
      </div>
    </>
  )
}
