'use client'

import { use, useState } from 'react'
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
  evidence: { quote?: string } | null
  confidence: number | null
  decision: string
  targetCardId: string | null
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

type Decision =
  | { itemId: string; decision: 'approved' | 'rejected' }
  | { itemId: string; decision: 'retargeted'; targetCardId: string }

export default function ChangeSetReviewPage({
  params,
}: {
  params: Promise<{ id: string; changeSetId: string }>
}) {
  const { id, changeSetId } = use(params)
  const router = useRouter()
  const { data, mutate } = useSWR<{ changeSet: ChangeSet }>(`/api/changesets/${changeSetId}`, fetcher)

  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [rejects, setRejects] = useState<Record<string, boolean>>({})
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [applying, setApplying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const cs = data?.changeSet
  const isPending = cs?.status === 'pending' || cs?.status === 'partially_applied'

  function toggleApprove(itemId: string) {
    setChecked((c) => {
      const next = !c[itemId]
      if (next) setRejects((r) => ({ ...r, [itemId]: false }))
      return { ...c, [itemId]: next }
    })
  }

  function toggleReject(itemId: string) {
    setRejects((r) => {
      const next = !r[itemId]
      if (next) setChecked((c) => ({ ...c, [itemId]: false }))
      return { ...r, [itemId]: next }
    })
  }

  // POST per-item decisions, then revalidate so item.decision reflects server state.
  async function postDecisions(decisions: Decision[]): Promise<boolean> {
    if (decisions.length === 0) return false
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`/api/changesets/${changeSetId}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setResult(body.error ?? res.statusText)
        return false
      }
      await mutate()
      return true
    } finally {
      setBusy(false)
    }
  }

  async function rejectSelected() {
    if (!cs) return
    const ids = cs.items.filter((it) => rejects[it.id] && it.decision === 'pending').map((it) => it.id)
    const ok = await postDecisions(ids.map((itemId) => ({ itemId, decision: 'rejected' as const })))
    if (ok) setRejects((r) => ({ ...r, ...Object.fromEntries(ids.map((i) => [i, false])) }))
  }

  async function retarget(itemId: string) {
    const targetCardId = (targets[itemId] ?? '').trim()
    if (!targetCardId) return
    const ok = await postDecisions([{ itemId, decision: 'retargeted', targetCardId }])
    if (ok) setTargets((t) => ({ ...t, [itemId]: '' }))
  }

  async function apply() {
    if (!cs) return
    const approvedItemIds = cs.items
      .filter((it) => checked[it.id] && !rejects[it.id])
      .map((it) => it.id)
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
        mutate()
      }
    } finally {
      setApplying(false)
    }
  }

  const rejectSelectedCount = cs
    ? cs.items.filter((it) => rejects[it.id] && it.decision === 'pending').length
    : 0

  return (
    <>
      <Topbar
        title="Review proposal"
        breadcrumb="// agents propose · humans approve"
        right={
          <button className="km-btn km-btn--ghost km-btn--sm" onClick={() => router.push(`/hud/${id}`)}>
            back to hud
          </button>
        }
      />
      <div style={{ padding: 24, maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!cs ? (
          <div className="km-mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Chip tone={cs.status === 'applied' ? 'ok' : cs.status === 'rejected' ? 'err' : 'warn'}>{cs.status}</Chip>
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
                {cs.items.map((it) => {
                  const struck = it.decision === 'rejected' || rejects[it.id]
                  const editable = isPending && it.decision === 'pending'
                  return (
                    <li
                      key={it.id}
                      style={{
                        borderBottom: '1px solid var(--line)',
                        padding: 14,
                        display: 'flex',
                        gap: 12,
                        opacity: struck ? 0.5 : 1,
                      }}
                    >
                      {editable && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 3 }}>
                          <label
                            className="km-mono"
                            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: 'var(--fg-3)' }}
                          >
                            <input
                              type="checkbox"
                              checked={!!checked[it.id]}
                              onChange={() => toggleApprove(it.id)}
                              aria-label={`approve ${it.op}`}
                            />
                            ok
                          </label>
                          <label
                            className="km-mono"
                            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: 'var(--err)' }}
                          >
                            <input
                              type="checkbox"
                              checked={!!rejects[it.id]}
                              onChange={() => toggleReject(it.id)}
                              aria-label={`reject ${it.op}`}
                            />
                            no
                          </label>
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Chip tone="accent">{it.op}</Chip>
                          {it.decision !== 'pending' && (
                            <Chip tone={it.decision === 'approved' ? 'ok' : it.decision === 'rejected' ? 'err' : 'warn'}>
                              {it.decision}
                            </Chip>
                          )}
                          {it.decision === 'retargeted' && it.targetCardId && (
                            <span className="km-mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
                              → {it.targetCardId}
                            </span>
                          )}
                          {typeof it.confidence === 'number' && (
                            <span className="km-mono" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
                              {(it.confidence * 100).toFixed(0)}%
                            </span>
                          )}
                        </div>
                        <pre
                          className="km-mono"
                          style={{
                            fontSize: 11,
                            color: 'var(--fg-2)',
                            marginTop: 6,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            textDecoration: struck ? 'line-through' : 'none',
                          }}
                        >
                          {JSON.stringify(it.payload, null, 2)}
                        </pre>
                        {it.evidence?.quote && (
                          <div className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>
                            evidence: “{it.evidence.quote}”
                          </div>
                        )}
                        {it.error && (
                          <div className="km-mono" style={{ fontSize: 10, color: 'var(--err)', marginTop: 4 }}>{it.error}</div>
                        )}
                        {editable && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                            <input
                              className="km-input"
                              value={targets[it.id] ?? ''}
                              onChange={(e) => setTargets((t) => ({ ...t, [it.id]: e.target.value }))}
                              placeholder="new target card id"
                              aria-label={`retarget ${it.op} card id`}
                              style={{ fontSize: 11, maxWidth: 220 }}
                            />
                            <button
                              className="km-btn km-btn--sm km-btn--ghost"
                              onClick={() => retarget(it.id)}
                              disabled={busy || !(targets[it.id] ?? '').trim()}
                            >
                              retarget
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>

            {isPending && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button className="km-btn km-btn--primary" onClick={apply} disabled={applying || busy}>
                  {applying ? 'applying…' : 'apply selected'}
                </button>
                <button
                  className="km-btn km-btn--sm km-btn--ghost"
                  onClick={rejectSelected}
                  disabled={busy || applying || rejectSelectedCount === 0}
                >
                  {`reject selected${rejectSelectedCount ? ` (${rejectSelectedCount})` : ''}`}
                </button>
                <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
                  only checked items are applied — rejected items are excluded
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
