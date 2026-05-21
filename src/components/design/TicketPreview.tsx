'use client'

import { GitPullRequestArrow, UserPlus, Archive, ExternalLink } from 'lucide-react'
import { Avatar } from './Avatar'
import { KV } from './KV'
import { PriorityBar } from './PriorityBar'
import type { TicketRowData } from './TicketRow'

interface TicketPreviewProps {
  ticket: TicketRowData
  onClose: (ticketId: string) => Promise<void>
  onViewFull: (ticketId: string) => void
}

const STATUS_BORDER: Record<string, string> = {
  open: 'var(--accent)',
  in_progress: 'var(--warn)',
  waiting: 'var(--fg-3)',
  resolved: 'var(--ok)',
  closed: 'var(--fg-4)',
}
const STATUS_COLOR: Record<string, string> = {
  open: 'var(--accent)',
  in_progress: 'var(--warn)',
  waiting: 'var(--fg-2)',
  resolved: 'var(--ok)',
  closed: 'var(--fg-4)',
}

const PRIORITY_LABEL: Record<string, string> = {
  low: 'low', medium: 'medium', high: 'high', urgent: 'urgent',
}
const PRIORITY_COLOR: Record<string, string> = {
  low: 'var(--p-low)', medium: 'var(--p-medium)', high: 'var(--p-high)', urgent: 'var(--p-critical)',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Right-pane preview for the selected ticket on the helpdesk index. No data fetching. */
export function TicketPreview({ ticket, onClose, onViewFull }: TicketPreviewProps) {
  const statusBorder = STATUS_BORDER[ticket.status] ?? 'var(--line)'
  const statusColor = STATUS_COLOR[ticket.status] ?? 'var(--fg-3)'

  return (
    <aside
      style={{ overflow: 'auto', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}
      aria-label="Ticket preview"
    >
      {/* Header */}
      <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
            #{ticket.number}
          </span>
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
          <span
            className="km-mono"
            style={{ fontSize: 10, color: PRIORITY_COLOR[ticket.priority] ?? 'var(--fg-3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}
          >
            {PRIORITY_LABEL[ticket.priority] ?? ticket.priority}
          </span>
        </div>
        <h2
          style={{
            fontSize: 17, fontWeight: 600, letterSpacing: '-0.015em',
            color: 'var(--fg-0)', lineHeight: 1.3, margin: 0,
            fontFamily: 'var(--font-display)',
          }}
        >
          {ticket.title}
        </h2>
        <div className="km-mono" style={{ marginTop: 8, fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.04em' }}>
          {ticket.reporter ? `@ ${ticket.reporter.email}` : ticket.agentName ? `agent ${ticket.agentName}` : 'unknown'}
          {' · '}opened {formatDate(ticket.createdAt)}
        </div>
      </div>

      {/* Quick actions */}
      <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
        <button
          className="km-btn km-btn--sm km-btn--primary"
          aria-label="Promote ticket to board (not yet available)"
          title="Promote to board — requires board integration"
          disabled
          style={{ opacity: 0.5, cursor: 'not-allowed' }}
        >
          <GitPullRequestArrow size={11} /> promote to board
        </button>
        <button className="km-btn km-btn--sm" aria-label="View full ticket" onClick={() => onViewFull(ticket.id)}>
          <ExternalLink size={11} /> view full
        </button>
        {ticket.status !== 'closed' && (
          <button
            className="km-btn km-btn--sm"
            aria-label="Close this ticket"
            onClick={() => onClose(ticket.id)}
          >
            <Archive size={11} /> close
          </button>
        )}
        {ticket.assignee ? (
          <button className="km-btn km-btn--sm" aria-label="Reassign ticket" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }}>
            <UserPlus size={11} /> reassign
          </button>
        ) : null}
      </div>

      {/* Metadata */}
      <div style={{ flexShrink: 0 }}>
        <KV label="reporter">
          {ticket.reporter ? (
            <>
              <Avatar name={ticket.reporter.name} size="sm" />
              <span className="km-mono" style={{ fontSize: 11 }}>{ticket.reporter.email}</span>
            </>
          ) : (
            <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
              {ticket.agentName ? `agent ${ticket.agentName}` : '–'}
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
          <span className="km-mono" style={{ fontSize: 11 }}>{formatDate(ticket.createdAt)}</span>
        </KV>
        <KV label="comments">
          <span className="km-mono" style={{ fontSize: 11 }}>{ticket._count.comments}</span>
        </KV>
      </div>

      {/* Empty state for description */}
      <div style={{ padding: '16px 18px', borderTop: '1px solid var(--line-faint)' }}>
        <div className="km-eyebrow" style={{ fontSize: 9, marginBottom: 8 }}>
          {'/// original message'}
        </div>
        <p style={{ fontSize: 13, color: 'var(--fg-3)', fontStyle: 'italic', lineHeight: 1.6 }}>
          Click <em>view full</em> to read the full description and comments.
        </p>
      </div>
    </aside>
  )
}
