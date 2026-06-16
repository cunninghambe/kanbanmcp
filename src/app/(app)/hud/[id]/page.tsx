'use client'

import { use, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import ReactMarkdown from 'react-markdown'
import { Topbar } from '@/components/design/Topbar'
import { Chip } from '@/components/design/Chip'
import { useHudStream } from '@/hooks/useHudStream'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

const TARGETS = ['board', 'drive', 'email', 'slack'] as const
type Target = (typeof TARGETS)[number]

type Citation = { kind: string; id?: string; title?: string; url?: string; quote?: string }
type Dispatch = {
  id: string
  target: Target
  question: string
  status: string
  answer: string | null
  citations: Citation[] | null
  confidence: number | null
  proposedChangeSetId: string | null
  error: string | null
  createdAt: string
}
type HudSession = {
  id: string
  title: string
  status: string
  boardId: string | null
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | undefined> = {
  done: 'ok',
  running: 'warn',
  queued: 'warn',
  failed: 'err',
  cancelled: undefined,
}

export default function HudSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, mutate } = useSWR<{ session: HudSession; dispatches: Dispatch[] }>(
    `/api/hud/${id}`,
    fetcher,
    { refreshInterval: 5000 }
  )
  const { data: changeData } = useSWR<{ changeSets: { id: string; status: string }[] }>(
    `/api/changesets?hudSessionId=${id}`,
    fetcher,
    { refreshInterval: 5000 }
  )

  useHudStream({ sessionId: id })

  const [target, setTarget] = useState<Target>('board')
  const [question, setQuestion] = useState('')
  const [firing, setFiring] = useState(false)

  const session = data?.session
  const dispatches = data?.dispatches ?? []
  const pendingChanges = (changeData?.changeSets ?? []).filter((c) => c.status === 'pending')
  const isLive = session?.status === 'live'

  async function fire(e: React.FormEvent) {
    e.preventDefault()
    if (!question.trim() || !isLive) return
    setFiring(true)
    try {
      const res = await fetch(`/api/hud/${id}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, question: question.trim() }),
      })
      if (res.ok) {
        setQuestion('')
        mutate()
      }
    } finally {
      setFiring(false)
    }
  }

  async function cancel(dispatchId: string) {
    await fetch(`/api/hud/dispatch/${dispatchId}/cancel`, { method: 'POST' })
    mutate()
  }

  async function endSession() {
    await fetch(`/api/hud/${id}/end`, { method: 'POST' })
    mutate()
  }

  return (
    <>
      <Topbar
        title={session?.title ?? 'HUD'}
        breadcrumb="// host meeting hud"
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Chip tone={isLive ? 'ok' : undefined} dot={isLive}>
              {session?.status ?? '…'}
            </Chip>
            {isLive && (
              <button className="km-btn km-btn--ghost km-btn--sm" onClick={endSession}>
                end session
              </button>
            )}
          </div>
        }
      />

      <div style={{ display: 'flex', gap: 16, padding: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Pertinent panel */}
        <aside style={{ flex: '0 0 240px', border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
            <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>{'/// pertinent'}</span>
          </div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {session?.boardId ? (
              <Link href={`/board/${session.boardId}`} className="km-mono" style={{ fontSize: 12, color: 'var(--accent)' }}>
                ▸ open board
              </Link>
            ) : (
              <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>no board attached</span>
            )}
            <div>
              <div className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)', marginBottom: 6 }}>
                suggested changes
              </div>
              {pendingChanges.length === 0 ? (
                <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>none pending</span>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {pendingChanges.map((c) => (
                    <li key={c.id}>
                      <Link href={`/hud/${id}/changes/${c.id}`} className="km-mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                        ▸ review proposal
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="km-mono" style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 8, lineHeight: 1.5 }}>
                agents never change the board live — proposals wait for your approval.
              </p>
            </div>
          </div>
        </aside>

        {/* Agent console */}
        <section style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <form onSubmit={fire} style={{ border: '1px solid var(--line)', background: 'var(--bg-1)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {TARGETS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTarget(t)}
                  className="km-chip"
                  style={{
                    cursor: 'pointer',
                    background: target === t ? 'var(--accent)' : 'transparent',
                    color: target === t ? 'var(--bg-0)' : 'var(--fg-2)',
                    border: '1px solid var(--line)',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            <textarea
              className="km-input"
              placeholder={isLive ? `Ask the ${target} agent…` : 'Session ended — dispatch disabled'}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={!isLive}
              rows={2}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="km-btn km-btn--primary km-btn--sm" disabled={!isLive || firing || !question.trim()}>
                {firing ? 'dispatching…' : 'dispatch agent'}
              </button>
            </div>
          </form>

          {dispatches.length === 0 && (
            <div className="km-mono" style={{ fontSize: 12, color: 'var(--fg-3)', padding: 16, textAlign: 'center' }}>
              no agents dispatched yet
            </div>
          )}

          {dispatches.map((d) => (
            <article key={d.id} style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-2)' }}>
                <Chip>{d.target}</Chip>
                <span style={{ flex: 1, fontSize: 13 }}>{d.question}</span>
                <Chip tone={STATUS_TONE[d.status]} dot={d.status === 'running' || d.status === 'queued'}>
                  {d.status}
                </Chip>
                {(d.status === 'running' || d.status === 'queued') && (
                  <button className="km-btn km-btn--ghost km-btn--sm" onClick={() => cancel(d.id)}>
                    cancel
                  </button>
                )}
              </div>
              <div style={{ padding: 14 }}>
                {d.status === 'done' && d.answer ? (
                  <div className="km-prose" style={{ fontSize: 13, lineHeight: 1.6 }}>
                    <ReactMarkdown>{d.answer}</ReactMarkdown>
                  </div>
                ) : d.status === 'failed' ? (
                  <div className="km-mono" style={{ fontSize: 11, color: 'var(--err)' }}>{d.error ?? 'failed'}</div>
                ) : (
                  <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>working…</div>
                )}

                {d.citations && d.citations.length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>citations</div>
                    {d.citations.map((c, i) => (
                      <div key={i} className="km-mono" style={{ fontSize: 10, color: 'var(--fg-2)' }}>
                        [{c.kind}] {c.url ? <a href={c.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{c.title ?? c.url}</a> : c.title ?? c.id}
                        {c.quote ? ` — “${c.quote}”` : ''}
                      </div>
                    ))}
                  </div>
                )}

                {d.proposedChangeSetId && (
                  <div style={{ marginTop: 10 }}>
                    <Link href={`/hud/${id}/changes/${d.proposedChangeSetId}`} className="km-mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                      ▸ this agent proposed a board change — review it
                    </Link>
                  </div>
                )}

                {typeof d.confidence === 'number' && (
                  <div className="km-mono" style={{ fontSize: 9, color: 'var(--fg-3)', marginTop: 8 }}>
                    confidence {(d.confidence * 100).toFixed(0)}%
                  </div>
                )}
              </div>
            </article>
          ))}
        </section>
      </div>
    </>
  )
}
