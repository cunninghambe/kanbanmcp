'use client'

import { Avatar } from './Avatar'
import { PriorityBar } from './PriorityBar'

export type TicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed'

export interface TicketRowData {
  id: string
  number: number
  title: string
  status: string
  priority: string
  agentName: string | null
  createdAt: string
  updatedAt: string
  reporter: { id: string; name: string; email: string } | null
  assignee: { id: string; name: string; email: string } | null
  _count: { comments: number }
}

interface TicketRowProps {
  ticket: TicketRowData
  selected: boolean
  onClick: () => void
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

function formatAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

/** Single row in the helpdesk ticket list. No data fetching. */
export function TicketRow({ ticket, selected, onClick }: TicketRowProps) {
  const statusBorder = STATUS_BORDER[ticket.status] ?? 'var(--line)'
  const statusColor = STATUS_COLOR[ticket.status] ?? 'var(--fg-3)'
  const reporterLabel =
    ticket.reporter?.name ?? ticket.agentName ?? 'unknown'
  const assigneeName = ticket.assignee?.name ?? '–'

  return (
    <button
      role="row"
      aria-selected={selected}
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '60px 64px 1fr 100px 56px',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        borderTop: '1px solid var(--line-faint)',
        borderLeft: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
        background: selected ? 'var(--bg-2)' : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        transition: 'background var(--dur-micro) var(--ease-out)',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-3)'
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
      }}
    >
      {/* ID */}
      <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
        #{ticket.number}
      </span>

      {/* Status badge */}
      <span
        className="km-mono"
        style={{
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          padding: '2px 5px',
          border: `1px solid ${statusBorder}`,
          color: statusColor,
          whiteSpace: 'nowrap',
        }}
      >
        {ticket.status.replace('_', ' ')}
      </span>

      {/* Title + reporter */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PriorityBar level={ticket.priority} />
          <span
            style={{
              fontSize: 13,
              color: 'var(--fg-0)',
              fontWeight: 500,
              letterSpacing: '-0.005em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {ticket.title}
          </span>
        </div>
        <div className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.04em', marginTop: 2 }}>
          {reporterLabel} · {ticket._count.comments} comment{ticket._count.comments !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Assignee */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {ticket.assignee ? (
          <>
            <Avatar name={ticket.assignee.name} size="sm" />
            <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {assigneeName.split(' ')[0].toLowerCase()}
            </span>
          </>
        ) : (
          <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-4)' }}>–</span>
        )}
      </div>

      {/* Age */}
      <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)', textAlign: 'right', letterSpacing: '0.06em' }}>
        {formatAge(ticket.updatedAt)}
      </span>
    </button>
  )
}
