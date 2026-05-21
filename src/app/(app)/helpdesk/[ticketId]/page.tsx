'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import useSWR from 'swr'
import { GitPullRequestArrow, ChevronLeft } from 'lucide-react'
import { Topbar } from '@/components/design/Topbar'
import { PriorityBar } from '@/components/design/PriorityBar'
import { TicketTimeline } from '@/components/design/TicketTimeline'
import { TicketRail } from '@/components/design/TicketRail'
import { Button } from '@/components/ui/Button'
import type { TimelineComment, TimelineActivity } from '@/components/design/TicketTimeline'
import type { TicketRailData } from '@/components/design/TicketRail'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TicketUser { id: string; name: string; email: string }

interface TicketDetail {
  id: string
  number: number
  title: string
  description: string | null
  status: string
  priority: string
  agentName: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  closedAt: string | null
  reporter: TicketUser | null
  assignee: TicketUser | null
  comments: TimelineComment[]
  activity: TimelineActivity[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const STATUS_BORDER: Record<string, string> = {
  open: 'var(--accent)', in_progress: 'var(--warn)', waiting: 'var(--fg-3)',
  resolved: 'var(--ok)', closed: 'var(--fg-4)',
}
const STATUS_COLOR: Record<string, string> = {
  open: 'var(--accent)', in_progress: 'var(--warn)', waiting: 'var(--fg-2)',
  resolved: 'var(--ok)', closed: 'var(--fg-4)',
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TicketDetailPage() {
  const params = useParams()
  const router = useRouter()
  const ticketId = params.ticketId as string

  const { data, mutate, isLoading } = useSWR<{ ticket: TicketDetail }>(
    `/api/tickets/${ticketId}`,
    fetcher
  )
  const ticket = data?.ticket ?? null

  const [saving, setSaving] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState('')

  async function patch(body: Record<string, unknown>) {
    setSaving(true)
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) await mutate()
    } finally {
      setSaving(false)
    }
  }

  async function handlePostComment(content: string, internal: boolean) {
    await fetch(`/api/tickets/${ticketId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, internal }),
    })
    await mutate()
  }

  async function handleDelete() {
    const res = await fetch(`/api/tickets/${ticketId}`, { method: 'DELETE' })
    if (res.ok) router.push('/helpdesk')
  }

  async function saveTitle() {
    if (titleDraft.trim() && titleDraft !== ticket?.title) await patch({ title: titleDraft.trim() })
    setEditingTitle(false)
  }

  async function saveDesc() {
    await patch({ description: descDraft.trim() || null })
    setEditingDesc(false)
  }

  // Loading state
  if (isLoading) {
    return (
      <>
        <Topbar
          breadcrumb="manage / helpdesk / …"
          title="loading…"
          right={
            <button className="km-btn km-btn--sm" onClick={() => router.push('/helpdesk')}>
              <ChevronLeft size={13} /> helpdesk
            </button>
          }
        />
        <div className="km-mono" style={{ padding: '48px 24px', fontSize: 12, color: 'var(--fg-3)', textAlign: 'center' }}>
          loading…
        </div>
      </>
    )
  }

  // Not found state
  if (!ticket) {
    return (
      <>
        <Topbar
          breadcrumb="manage / helpdesk"
          title="ticket not found"
          right={
            <button className="km-btn km-btn--sm" onClick={() => router.push('/helpdesk')}>
              <ChevronLeft size={13} /> helpdesk
            </button>
          }
        />
        <div className="km-mono" style={{ padding: '48px 24px', fontSize: 12, color: 'var(--fg-3)', textAlign: 'center' }}>
          ticket not found
        </div>
      </>
    )
  }

  const statusBorder = STATUS_BORDER[ticket.status] ?? 'var(--line)'
  const statusColor = STATUS_COLOR[ticket.status] ?? 'var(--fg-3)'

  const railData: TicketRailData = {
    status: ticket.status,
    priority: ticket.priority,
    reporter: ticket.reporter,
    assignee: ticket.assignee,
    agentName: ticket.agentName,
    createdAt: ticket.createdAt,
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,
  }

  const topbarRight = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button className="km-btn km-btn--sm" onClick={() => router.push('/helpdesk')}>
        <ChevronLeft size={13} /> helpdesk
      </button>
      <div style={{ width: 1, height: 20, background: 'var(--line)' }} />
      <button
        className="km-btn km-btn--sm km-btn--primary"
        disabled
        title="Promote to board — requires board integration"
        style={{ opacity: 0.5, cursor: 'not-allowed' }}
        aria-label="Promote to board (not yet available)"
      >
        <GitPullRequestArrow size={11} /> promote to board
      </button>
    </div>
  )

  return (
    <>
      <Topbar
        breadcrumb={`manage / helpdesk / #${ticket.number}`}
        title={ticket.title}
        right={topbarRight}
      />

      <main
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'grid',
          gridTemplateColumns: '1fr 280px',
          alignItems: 'start',
        }}
      >
        {/* Main column */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {/* Ticket header */}
          <div style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
              <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>/// ticket</span>
            </div>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span
                  className="km-mono"
                  style={{
                    fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
                    padding: '2px 7px', border: `1px solid ${statusBorder}`, color: statusColor,
                  }}
                >
                  {ticket.status.replace('_', ' ')}
                </span>
                <PriorityBar level={ticket.priority} />
                <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
                  #{ticket.number}
                </span>
              </div>

              {editingTitle ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <input
                    autoFocus
                    className="km-input"
                    value={titleDraft}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitleDraft(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent) => {
                      if (e.key === 'Enter') saveTitle()
                      if (e.key === 'Escape') setEditingTitle(false)
                    }}
                    style={{ flex: 1, height: 36, fontSize: 16 }}
                    aria-label="Edit ticket title"
                  />
                  <Button size="sm" onClick={saveTitle} disabled={saving}>save</Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditingTitle(false)}>cancel</Button>
                </div>
              ) : (
                <h1
                  style={{
                    fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--fg-0)',
                    lineHeight: 1.3, marginBottom: 8, cursor: 'pointer', fontFamily: 'var(--font-display)',
                  }}
                  onClick={() => { setTitleDraft(ticket.title); setEditingTitle(true) }}
                  title="Click to edit title"
                >
                  {ticket.title}
                </h1>
              )}
              <div className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.04em' }}>
                opened {fmt(ticket.createdAt)}{' by '}
                {ticket.reporter?.name ?? ticket.agentName ?? 'unknown'}
              </div>
            </div>
          </div>

          {/* Description */}
          <div style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
            <div style={{
              padding: '10px 16px', borderBottom: '1px solid var(--line)',
              background: 'var(--bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>/// description</span>
              {!editingDesc && (
                <button
                  className="km-btn km-btn--sm km-btn--ghost"
                  onClick={() => { setDescDraft(ticket.description ?? ''); setEditingDesc(true) }}
                  aria-label="Edit description"
                  style={{ fontSize: 11, height: 22 }}
                >
                  edit
                </button>
              )}
            </div>
            <div style={{ padding: '14px 16px' }}>
              {editingDesc ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <textarea
                    autoFocus
                    className="km-input"
                    value={descDraft}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescDraft(e.target.value)}
                    rows={6}
                    style={{ height: 'auto', resize: 'vertical', fontSize: 13 }}
                    aria-label="Edit description"
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button size="sm" onClick={saveDesc} disabled={saving}>save</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditingDesc(false)}>cancel</Button>
                  </div>
                </div>
              ) : ticket.description ? (
                <p style={{ fontSize: 13, color: 'var(--fg-1)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  {ticket.description}
                </p>
              ) : (
                <p className="km-mono" style={{ fontSize: 12, color: 'var(--fg-4)' }}>no description provided.</p>
              )}
            </div>
          </div>

          {/* Activity timeline */}
          <TicketTimeline
            comments={ticket.comments}
            activity={ticket.activity}
            onPostComment={handlePostComment}
          />
        </div>

        {/* Right rail */}
        <TicketRail
          ticket={railData}
          saving={saving}
          onPatch={patch}
          onDelete={handleDelete}
        />
      </main>
    </>
  )
}
