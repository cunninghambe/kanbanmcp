'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Avatar } from './Avatar'
import { KV } from './KV'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RailUser { id: string; name: string; email: string }

type StatusValue = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed'
type PriorityValue = 'low' | 'medium' | 'high' | 'urgent'

export interface TicketRailData {
  status: string
  priority: string
  reporter: RailUser | null
  assignee: RailUser | null
  agentName: string | null
  createdAt: string
  resolvedAt: string | null
  closedAt: string | null
}

interface TicketRailProps {
  ticket: TicketRailData
  saving: boolean
  onPatch: (body: Record<string, unknown>) => Promise<void>
  onDelete: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: 'open', label: 'open' },
  { value: 'in_progress', label: 'in progress' },
  { value: 'waiting', label: 'waiting' },
  { value: 'resolved', label: 'resolved' },
  { value: 'closed', label: 'closed' },
]

const PRIORITY_OPTIONS: { value: PriorityValue; label: string }[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'urgent', label: 'urgent' },
]

const STATUS_BORDER: Record<string, string> = {
  open: 'var(--accent)', in_progress: 'var(--warn)', waiting: 'var(--fg-3)',
  resolved: 'var(--ok)', closed: 'var(--fg-4)',
}
const STATUS_COLOR: Record<string, string> = {
  open: 'var(--accent)', in_progress: 'var(--warn)', waiting: 'var(--fg-2)',
  resolved: 'var(--ok)', closed: 'var(--fg-4)',
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Right rail for ticket detail page: status/priority selects, metadata KVs,
 * quick-action status buttons, and danger zone delete.
 * No data fetching — caller passes ticket data + handlers.
 */
export function TicketRail({ ticket, saving, onPatch, onDelete }: TicketRailProps) {
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  const statusBorder = STATUS_BORDER[ticket.status] ?? 'var(--line)'
  const statusColor = STATUS_COLOR[ticket.status] ?? 'var(--fg-3)'

  return (
    <aside
      style={{
        borderLeft: '1px solid var(--line)',
        background: 'var(--bg-1)',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div style={{ borderBottom: '1px solid var(--line)', padding: '10px 16px', background: 'var(--bg-2)' }}>
        <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>{'/// details'}</span>
      </div>

      {/* Status + priority selects */}
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)', marginBottom: 4 }}>status</div>
          <select
            className="km-input"
            value={ticket.status}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onPatch({ status: e.target.value })}
            disabled={saving}
            aria-label="Ticket status"
            style={{
              border: `1px solid ${statusBorder}`,
              color: statusColor,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)', marginBottom: 4 }}>priority</div>
          <select
            className="km-input"
            value={ticket.priority}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onPatch({ priority: e.target.value })}
            disabled={saving}
            aria-label="Ticket priority"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
          >
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="km-hr" />

      {/* Metadata */}
      <KV label="reporter">
        {ticket.reporter ? (
          <>
            <Avatar name={ticket.reporter.name} size="sm" />
            <span className="km-mono" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ticket.reporter.name}
            </span>
          </>
        ) : (
          <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            {ticket.agentName ?? '–'}
          </span>
        )}
      </KV>
      <KV label="assignee">
        {ticket.assignee ? (
          <>
            <Avatar name={ticket.assignee.name} size="sm" />
            <span className="km-mono" style={{ fontSize: 11 }}>{ticket.assignee.name}</span>
          </>
        ) : (
          <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>unassigned</span>
        )}
      </KV>
      <KV label="opened">
        <span className="km-mono" style={{ fontSize: 11 }}>{fmt(ticket.createdAt)}</span>
      </KV>
      {ticket.resolvedAt && (
        <KV label="resolved">
          <span className="km-mono" style={{ fontSize: 11 }}>{fmt(ticket.resolvedAt)}</span>
        </KV>
      )}
      {ticket.closedAt && (
        <KV label="closed">
          <span className="km-mono" style={{ fontSize: 11 }}>{fmt(ticket.closedAt)}</span>
        </KV>
      )}

      <div className="km-hr" />

      {/* Quick actions */}
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)', marginBottom: 4 }}>quick actions</div>
        {ticket.status !== 'in_progress' && (
          <button
            className="km-btn km-btn--sm"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => onPatch({ status: 'in_progress' })}
            disabled={saving}
          >
            mark in progress
          </button>
        )}
        {ticket.status !== 'resolved' && (
          <button
            className="km-btn km-btn--sm"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => onPatch({ status: 'resolved' })}
            disabled={saving}
          >
            mark resolved
          </button>
        )}
        {ticket.status !== 'closed' && (
          <button
            className="km-btn km-btn--sm"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => onPatch({ status: 'closed' })}
            disabled={saving}
          >
            close ticket
          </button>
        )}
        {(ticket.status === 'resolved' || ticket.status === 'closed') && (
          <button
            className="km-btn km-btn--sm"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => onPatch({ status: 'open' })}
            disabled={saving}
          >
            re-open
          </button>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {/* Danger zone */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
        <div className="km-eyebrow" style={{ fontSize: 9, color: 'var(--err)', marginBottom: 8 }}>danger zone</div>
        {deleteConfirm ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="km-mono" style={{ fontSize: 10, color: 'var(--err)' }}>cannot be undone.</span>
            <button
              className="km-btn km-btn--sm km-btn--primary"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={onDelete}
            >
              <Trash2 size={11} /> confirm delete
            </button>
            <button
              className="km-btn km-btn--sm"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => setDeleteConfirm(false)}
            >
              cancel
            </button>
          </div>
        ) : (
          <button
            className="km-btn km-btn--sm"
            style={{ width: '100%', justifyContent: 'center', border: '1px solid var(--err)', color: 'var(--err)' }}
            onClick={() => setDeleteConfirm(true)}
          >
            <Trash2 size={11} /> delete ticket
          </button>
        )}
      </div>
    </aside>
  )
}
