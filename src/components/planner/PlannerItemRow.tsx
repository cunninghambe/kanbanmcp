'use client'

import { useState } from 'react'
import {
  Check,
  Clock,
  X,
  Ban,
  RotateCcw,
  Mail,
  Calendar,
  Slack,
  Kanban,
  ListTodo,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Chip } from '@/components/design/Chip'
import { SnoozeMenu } from './SnoozeMenu'
import type { PlannerAction, RankedItemDTO } from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §7.3 "Rows" and §7.4.

export interface PlannerItemRowProps {
  item: RankedItemDTO
  selected: boolean
  onSelect: () => void
  onAct: (action: PlannerAction, extra?: { snoozedUntil?: string }) => void
  error?: string | null
  onRetry?: () => void
  onDismissError?: () => void
  /** Controlled snooze-menu state (PlannerList's `s` shortcut); uncontrolled when omitted. */
  snoozeOpen?: boolean
  onSnoozeOpenChange?: (open: boolean) => void
}

function reasonTone(reason: string): 'err' | 'accent' | undefined {
  if (/^overdue/.test(reason)) return 'err'
  if (/^meeting/.test(reason) || reason === 'urgent email') return 'accent'
  return undefined
}

const SOURCE_ICON: Record<RankedItemDTO['source'], LucideIcon> = {
  card: Kanban,
  email: Mail,
  calendar: Calendar,
  slack: Slack,
  manual: ListTodo,
}

function timeHint(item: RankedItemDTO): string | null {
  if (item.startsAt) {
    return new Date(item.startsAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }
  if (item.dueAt) {
    return new Date(item.dueAt)
      .toLocaleDateString([], { day: 'numeric', month: 'short' })
      .toLowerCase()
  }
  return null
}

const RESOLVED_STATUSES = new Set(['done', 'dismissed', 'wont_do'])

export function PlannerItemRow({
  item,
  selected,
  onSelect,
  onAct,
  error,
  onRetry,
  onDismissError,
  snoozeOpen: snoozeOpenProp,
  onSnoozeOpenChange,
}: PlannerItemRowProps) {
  const [snoozeOpenState, setSnoozeOpenState] = useState(false)
  const snoozeOpen = snoozeOpenProp ?? snoozeOpenState
  const setSnoozeOpen = (open: boolean) => {
    setSnoozeOpenState(open)
    onSnoozeOpenChange?.(open)
  }
  const resolved = RESOLVED_STATUSES.has(item.status)
  const isReviewOnly =
    item.source === 'card' && (item.payload.role === 'reviewer' || item.payload.role === 'approver')
  const Icon = SOURCE_ICON[item.source]
  const hint = timeHint(item)

  return (
    // aria-selected on role="listitem" is the spec's contract (§7.4) — the
    // row selection state the tests assert on.
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props
    <li
      id={`planner-item-${item.id}`}
      role="listitem"
      aria-label={item.title}
      aria-selected={selected}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 10px',
        borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
        borderBottom: '1px solid var(--line-faint)',
        background: selected ? 'var(--bg-2)' : 'transparent',
        position: 'relative',
      }}
    >
      <span style={{ color: 'var(--fg-3)', flexShrink: 0, paddingTop: 2 }}>
        <Icon size={13} />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <button
          type="button"
          onClick={onSelect}
          style={{
            display: 'block',
            width: '100%',
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: 13,
            color: 'var(--fg-0)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.title}
        </button>
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, alignItems: 'center' }}
        >
          {item.reasons.map((r) => (
            <Chip key={r} tone={reasonTone(r)}>
              {r}
            </Chip>
          ))}
          {hint && (
            <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
              {hint}
            </span>
          )}
          {error && (
            <>
              <Chip tone="err">{error}</Chip>
              <button
                type="button"
                onClick={onRetry}
                className="km-mono"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent)',
                  cursor: 'pointer',
                  fontSize: 10,
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                retry
              </button>
              <button
                type="button"
                onClick={onDismissError}
                aria-label="Dismiss error"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--fg-3)',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 12,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, flexShrink: 0, position: 'relative' }}>
        {resolved ? (
          <button
            type="button"
            aria-label="Reopen"
            onClick={() => onAct('reopen')}
            className="km-btn km-btn--ghost km-btn--sm"
            style={{ padding: 4 }}
          >
            <RotateCcw size={13} />
          </button>
        ) : (
          <>
            <button
              type="button"
              aria-label={isReviewOnly ? 'Mark reviewed' : 'Mark done'}
              onClick={() => onAct('done')}
              className="km-btn km-btn--ghost km-btn--sm"
              style={{ padding: 4 }}
            >
              <Check size={13} />
            </button>
            <button
              type="button"
              aria-label="Snooze"
              onClick={() => setSnoozeOpen(!snoozeOpen)}
              className="km-btn km-btn--ghost km-btn--sm"
              style={{ padding: 4 }}
            >
              <Clock size={13} />
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => onAct('dismiss')}
              className="km-btn km-btn--ghost km-btn--sm"
              style={{ padding: 4 }}
            >
              <X size={13} />
            </button>
            <button
              type="button"
              aria-label="Won't do"
              onClick={() => onAct('wont_do')}
              className="km-btn km-btn--ghost km-btn--sm"
              style={{ padding: 4 }}
            >
              <Ban size={13} />
            </button>
            {snoozeOpen && (
              <SnoozeMenu
                onPick={(snoozedUntilIso) => {
                  setSnoozeOpen(false)
                  onAct('snooze', { snoozedUntil: snoozedUntilIso })
                }}
                onClose={() => setSnoozeOpen(false)}
              />
            )}
          </>
        )}
      </div>
    </li>
  )
}
