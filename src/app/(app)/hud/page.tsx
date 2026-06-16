'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import useSWR from 'swr'
import { RadioTower } from 'lucide-react'
import { Topbar } from '@/components/design/Topbar'
import { Chip } from '@/components/design/Chip'
import { useSession } from '@/hooks/useSession'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

type HudSession = {
  id: string
  title: string
  status: string
  boardId: string | null
  startedAt: string
  endedAt: string | null
}

type Board = { id: string; name: string }

export default function HudIndexPage() {
  const router = useRouter()
  const { org } = useSession()
  const { data, mutate } = useSWR<{ sessions: HudSession[] }>('/api/hud', fetcher)
  const { data: boardsData } = useSWR(org ? `/api/orgs/${org.id}/boards` : null, fetcher)
  const boards: Board[] = boardsData?.boards ?? boardsData ?? []

  const [title, setTitle] = useState('')
  const [boardId, setBoardId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sessions = data?.sessions ?? []

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/hud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), ...(boardId ? { boardId } : {}) }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? res.statusText)
        return
      }
      const body = (await res.json()) as { session: { id: string } }
      mutate()
      router.push(`/hud/${body.session.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start HUD')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Topbar title="Host Meeting HUD" breadcrumb="// live in-meeting copilot" />
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 880 }}>
        <section style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
            <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>{'/// start a session'}</span>
          </div>
          <form onSubmit={handleCreate} style={{ padding: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 220 }}>
              <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>meeting title</span>
              <input
                className="km-input"
                placeholder="Weekly exec sync…"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{ height: 32 }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
              <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>board (optional)</span>
              <select
                className="km-input"
                value={boardId}
                onChange={(e) => setBoardId(e.target.value)}
                style={{ height: 32 }}
              >
                <option value="">— none —</option>
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="km-btn km-btn--primary" disabled={submitting || !title.trim()}>
              {submitting ? 'starting…' : 'go live'}
            </button>
          </form>
          {error && (
            <div className="km-mono" role="alert" style={{ padding: '0 16px 14px', fontSize: 11, color: 'var(--err)' }}>
              {error}
            </div>
          )}
        </section>

        <section style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
            <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>{'/// sessions'}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="km-mono" style={{ padding: 16, fontSize: 12, color: 'var(--fg-3)' }}>no sessions yet</div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {sessions.map((s) => (
                <li key={s.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <Link
                    href={`/hud/${s.id}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', textDecoration: 'none', color: 'var(--fg-1)' }}
                  >
                    <RadioTower size={14} style={{ color: s.status === 'live' ? 'var(--ok)' : 'var(--fg-3)' }} />
                    <span style={{ flex: 1 }}>{s.title}</span>
                    <Chip tone={s.status === 'live' ? 'ok' : undefined} dot={s.status === 'live'}>
                      {s.status}
                    </Chip>
                    <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
                      {new Date(s.startedAt).toLocaleString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
