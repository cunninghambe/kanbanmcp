import type { ReactNode } from 'react'
import { Pip } from './Pip'
import type { PipTone } from './Pip'

export interface QueueRow {
  id: string
  cardId: string
  boardId: string
  title: string
  priority: string
  boardName: string
  columnName: string
  dueDate: string | null
  /** If true, renders the due date in error colour */
  overdue?: boolean
}

interface QueueTableProps {
  label: string
  count: number
  /** Pip accent for the header */
  accent?: PipTone
  /** Optional trailing hint (e.g. "oldest · 16h") */
  hint?: string
  rows: QueueRow[]
  onRowClick: (row: QueueRow) => void
  /** Shown when rows is empty */
  emptyLabel?: string
}

/**
 * A hairline-bordered queue section with a mono header and a grid of rows.
 * Each row is keyboard-accessible (button) and fires onRowClick with the row.
 * Does not fetch data or manage routing.
 */
export function QueueTable({
  label,
  count,
  accent,
  hint,
  rows,
  onRowClick,
  emptyLabel = 'nothing here',
}: QueueTableProps) {
  const statusColor = (col: string) => {
    const l = col.toLowerCase()
    if (l.includes('review')) return 'var(--warn)'
    if (l.includes('done') || l.includes('closed')) return 'var(--ok)'
    if (l.includes('progress') || l.includes('doing') || l.includes('wip')) return 'var(--accent)'
    return 'var(--fg-3)'
  }

  const statusLabel = (col: string) => {
    const l = col.toLowerCase()
    if (l.includes('review')) return 'review'
    if (l.includes('done') || l.includes('closed')) return 'done'
    if (l.includes('progress') || l.includes('doing')) return 'wip'
    return col.slice(0, 6)
  }

  const priorityColor = (p: string): string => {
    const map: Record<string, string> = {
      critical: 'var(--p-critical)',
      high: 'var(--p-high)',
      medium: 'var(--p-medium)',
      low: 'var(--p-low)',
    }
    return map[p?.toLowerCase()] ?? 'transparent'
  }

  const formatDue = (row: QueueRow): ReactNode => {
    if (!row.dueDate) return <span style={{ color: 'var(--fg-3)' }}>—</span>
    const d = new Date(row.dueDate)
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return (
      <span style={{ color: row.overdue ? 'var(--err)' : 'var(--fg-2)', fontWeight: row.overdue ? 600 : 400 }}>
        {row.overdue && '✗ '}{label}
      </span>
    )
  }

  return (
    <section
      style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}
      aria-label={label}
    >
      <header
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'var(--bg-2)',
        }}
      >
        {accent && <Pip tone={accent} />}
        <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>
          {label}
        </span>
        <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.08em' }}>
          {String(count).padStart(2, '0')}
        </span>
        <div style={{ flex: 1 }} />
        {hint && (
          <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
            {hint}
          </span>
        )}
      </header>

      {rows.length === 0 ? (
        <div
          className="km-mono"
          style={{ padding: '12px 16px', fontSize: 11, color: 'var(--fg-3)' }}
        >
          {emptyLabel}
        </div>
      ) : (
        <div role="list">
          {rows.map((row) => (
            <button
              key={row.cardId}
              role="listitem"
              onClick={() => onRowClick(row)}
              aria-label={`${row.id}: ${row.title}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '4px 80px 1fr 72px 90px',
                alignItems: 'center',
                gap: 12,
                padding: '10px 16px 10px 0',
                cursor: 'pointer',
                width: '100%',
                background: 'transparent',
                borderLeft: 'none',
                borderRight: 'none',
                borderBottom: 'none',
                borderTop: '1px solid var(--line-faint)',
                textAlign: 'left',
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onRowClick(row) }}
            >
              {/* priority bar */}
              <span
                aria-hidden="true"
                style={{ width: 3, height: 24, background: priorityColor(row.priority), display: 'block' }}
              />
              {/* card id */}
              <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.id}
              </span>
              {/* title */}
              <span style={{ fontSize: 13, color: 'var(--fg-0)', letterSpacing: '-0.005em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.title}
              </span>
              {/* status chip */}
              <span
                className="km-mono"
                style={{
                  fontSize: 9,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  padding: '1px 6px',
                  border: `1px solid ${statusColor(row.columnName)}`,
                  color: statusColor(row.columnName),
                  textAlign: 'center',
                  display: 'inline-block',
                }}
              >
                {statusLabel(row.columnName)}
              </span>
              {/* due date */}
              <span className="km-mono" style={{ fontSize: 11, textAlign: 'right' }}>
                {formatDue(row)}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
