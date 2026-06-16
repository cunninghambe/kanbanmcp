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

export default function ChangeSetReviewPage({
  params,
}: {
  params: Promise<{ id: string; changeSetId: string }>
}) {
  const { id, changeSetId } = use(params)
  const router = useRouter()
  const { data, mutate } = useSWR<{ changeSet: ChangeSet }>(`/api/changesets/${changeSetId}`, fetcher)

  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const cs = data?.changeSet
  const isPending = cs?.status === 'pending' || cs?.status === 'partially_applied'

  function toggle(itemId: string) {
    setChecked((c) => ({ ...c, [itemId]: !c[itemId] }))
  }

  async function apply() {
    if (!cs) return
    const approvedItemIds = cs.items.filter((it) => checked[it.id]).map((it) => it.id)
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
                {cs.items.map((it) => (
                  <li key={it.id} style={{ borderBottom: '1px solid var(--line)', padding: 14, display: 'flex', gap: 12 }}>
                    {isPending && it.decision !== 'approved' && (
                      <input
                        type="checkbox"
                        checked={!!checked[it.id]}
                        onChange={() => toggle(it.id)}
                        aria-label={`approve ${it.op}`}
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
                      <pre className="km-mono" style={{ fontSize: 11, color: 'var(--fg-2)', marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
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
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {isPending && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="km-btn km-btn--primary" onClick={apply} disabled={applying}>
                  {applying ? 'applying…' : 'apply selected'}
                </button>
                <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
                  only checked items are applied — nothing happens to the board otherwise
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
