'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { Plus, Search } from 'lucide-react'
import { Topbar } from '@/components/design/Topbar'
import { TicketRow } from '@/components/design/TicketRow'
import { TicketPreview } from '@/components/design/TicketPreview'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import type { TicketRowData } from '@/components/design/TicketRow'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusTab = 'all' | 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed'

interface TicketsResponse {
  tickets: TicketRowData[]
  pagination: { total: number }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

const TABS: { id: StatusTab; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'open', label: 'open' },
  { id: 'in_progress', label: 'in progress' },
  { id: 'waiting', label: 'waiting' },
  { id: 'resolved', label: 'resolved' },
  { id: 'closed', label: 'closed' },
]

const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'] as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HelpdeskPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<StatusTab>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newPriority, setNewPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium')
  const [creating, setCreating] = useState(false)

  // Fetch all tickets (no filter — we filter client-side for tab counts)
  const { data, mutate, isLoading } = useSWR<TicketsResponse>(
    '/api/tickets?limit=100',
    fetcher
  )
  const allTickets: TicketRowData[] = data?.tickets ?? []

  // Compute per-tab counts
  const counts: Record<StatusTab, number> = {
    all: allTickets.length,
    open: allTickets.filter((t) => t.status === 'open').length,
    in_progress: allTickets.filter((t) => t.status === 'in_progress').length,
    waiting: allTickets.filter((t) => t.status === 'waiting').length,
    resolved: allTickets.filter((t) => t.status === 'resolved').length,
    closed: allTickets.filter((t) => t.status === 'closed').length,
  }

  const visible = activeTab === 'all' ? allTickets : allTickets.filter((t) => t.status === activeTab)
  const selected = visible.find((t) => t.id === selectedId) ?? null

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newTitle.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim(), description: newDesc.trim() || null, priority: newPriority }),
      })
      if (res.ok) {
        const { ticket } = await res.json() as { ticket: TicketRowData }
        setShowNew(false)
        setNewTitle('')
        setNewDesc('')
        setNewPriority('medium')
        await mutate()
        router.push(`/helpdesk/${ticket.id}`)
      }
    } finally {
      setCreating(false)
    }
  }

  async function handleClose(ticketId: string) {
    await fetch(`/api/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    await mutate()
  }

  const topbarRight = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 1, height: 20, background: 'var(--line)' }} />
      <button className="km-btn km-btn--sm km-btn--primary" onClick={() => setShowNew(true)} aria-label="New ticket">
        <Plus size={13} /> new ticket
      </button>
    </div>
  )

  return (
    <>
      <Topbar breadcrumb="manage / helpdesk" title="helpdesk" right={topbarRight} />

      {/* Status tabs */}
      <div
        role="tablist"
        aria-label="Filter tickets by status"
        style={{
          height: 44,
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg-1)',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        {TABS.map((tab) => {
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => { setActiveTab(tab.id); setSelectedId(null) }}
              style={{
                padding: '0 14px',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                background: 'none',
                border: 'none',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                color: active ? 'var(--fg-0)' : 'var(--fg-2)',
                fontFamily: 'var(--font-body)',
                fontSize: 13,
                fontWeight: active ? 500 : 400,
                letterSpacing: '-0.005em',
                marginBottom: -1,
              }}
            >
              {tab.label}
              <span
                className="km-mono"
                style={{
                  fontSize: 9,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  padding: '1px 5px',
                  border: '1px solid var(--line)',
                  color: 'var(--fg-3)',
                }}
              >
                {String(counts[tab.id]).padStart(2, '0')}
              </span>
            </button>
          )
        })}
        <div style={{ flex: 1 }} />
        {/* Search placeholder */}
        <div
          style={{
            height: 28, display: 'flex', alignItems: 'center', gap: 6,
            border: '1px solid var(--line)', background: 'var(--bg-2)', padding: '0 8px',
          }}
          aria-label="Search tickets (coming soon)"
        >
          <Search size={11} color="var(--fg-3)" />
          <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>search tickets…</span>
        </div>
      </div>

      {/* Body — list + preview */}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: selected ? '1fr 380px' : '1fr',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {/* Ticket list */}
        <div
          role="rowgroup"
          aria-label="Ticket list"
          style={{ overflow: 'auto', borderRight: selected ? '1px solid var(--line)' : 'none', background: 'var(--bg-0)' }}
        >
          {/* Table header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '60px 64px 1fr 100px 56px',
              alignItems: 'center',
              gap: 12,
              padding: '8px 16px',
              borderBottom: '1px solid var(--line)',
              background: 'var(--bg-1)',
              position: 'sticky',
              top: 0,
              zIndex: 1,
            }}
          >
            <span className="km-eyebrow" style={{ fontSize: 9 }}>id</span>
            <span className="km-eyebrow" style={{ fontSize: 9 }}>state</span>
            <span className="km-eyebrow" style={{ fontSize: 9 }}>subject · reporter</span>
            <span className="km-eyebrow" style={{ fontSize: 9 }}>owner</span>
            <span className="km-eyebrow" style={{ fontSize: 9, textAlign: 'right' }}>age</span>
          </div>

          {isLoading ? (
            <div className="km-mono" style={{ padding: '32px 16px', fontSize: 12, color: 'var(--fg-3)', textAlign: 'center' }}>
              loading…
            </div>
          ) : visible.length === 0 ? (
            <div className="km-mono" style={{ padding: '48px 16px', fontSize: 12, color: 'var(--fg-3)', textAlign: 'center' }}>
              no tickets
            </div>
          ) : (
            visible.map((ticket) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                selected={ticket.id === selectedId}
                onClick={() => setSelectedId(ticket.id === selectedId ? null : ticket.id)}
              />
            ))
          )}
        </div>

        {/* Preview pane */}
        {selected && (
          <TicketPreview
            ticket={selected}
            onClose={handleClose}
            onViewFull={(id) => router.push(`/helpdesk/${id}`)}
          />
        )}
      </div>

      {/* New Ticket Modal */}
      <Modal open={showNew} onClose={() => { setShowNew(false); setNewTitle(''); setNewDesc('') }} title="New Ticket" size="md">
        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-2)', marginBottom: 4 }}>
              Title <span style={{ color: 'var(--accent)' }}>*</span>
            </label>
            <input
              className="km-input"
              type="text"
              value={newTitle}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewTitle(e.target.value)}
              placeholder="Briefly describe the issue"
              autoFocus
              required
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-2)', marginBottom: 4 }}>Description</label>
            <textarea
              className="km-input"
              value={newDesc}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNewDesc(e.target.value)}
              rows={4}
              placeholder="Provide additional details…"
              style={{ height: 'auto', resize: 'vertical' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-2)', marginBottom: 4 }}>Priority</label>
            <select
              className="km-input"
              value={newPriority}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                setNewPriority(e.target.value as typeof newPriority)
              }
            >
              {PRIORITY_OPTIONS.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
            <Button type="button" variant="secondary" onClick={() => { setShowNew(false); setNewTitle(''); setNewDesc('') }}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !newTitle.trim()}>
              {creating ? 'creating…' : 'create ticket'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  )
}
