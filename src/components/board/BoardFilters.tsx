'use client'

import { X, ChevronDown } from 'lucide-react'
import type { Card, Label, User } from '@/types'

export type Priority = 'critical' | 'high' | 'medium' | 'low' | 'none'

export interface FilterState {
  assignees: string[]    // user ids
  priorities: Priority[]
  labels: string[]       // label ids
}

export const EMPTY_FILTERS: FilterState = {
  assignees: [],
  priorities: [],
  labels: [],
}

export function hasActiveFilters(f: FilterState): boolean {
  return f.assignees.length > 0 || f.priorities.length > 0 || f.labels.length > 0
}

/** Apply filters to a card list. Returns all cards when filters are empty. */
export function filterCards<C extends Card & { assignee?: User | null; labels?: { label: Label }[]; priority?: string | null }>(
  cards: C[],
  filters: FilterState,
  searchQuery: string
): C[] {
  return cards.filter((card) => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      if (!card.title.toLowerCase().includes(q)) return false
    }
    if (filters.assignees.length > 0) {
      const aid = card.assigneeId ?? null
      if (!aid || !filters.assignees.includes(aid)) return false
    }
    if (filters.priorities.length > 0) {
      const p = (card.priority ?? 'none') as Priority
      if (!filters.priorities.includes(p)) return false
    }
    if (filters.labels.length > 0) {
      const cardLabelIds = (card.labels ?? []).map((cl) => cl.label.id)
      if (!filters.labels.some((id) => cardLabelIds.includes(id))) return false
    }
    return true
  })
}

// ---- sub-components ----

interface MemberOption {
  id: string
  name: string
}

interface LabelOption {
  id: string
  name: string
  color: string
}

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high',     label: 'High' },
  { value: 'medium',   label: 'Medium' },
  { value: 'low',      label: 'Low' },
  { value: 'none',     label: 'None' },
]

const PRIORITY_VARS: Record<Priority, string> = {
  critical: 'var(--p-critical)',
  high:     'var(--p-high)',
  medium:   'var(--p-medium)',
  low:      'var(--p-low)',
  none:     'var(--p-none)',
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="km-chip"
      style={{
        cursor: 'pointer',
        background: active ? 'var(--accent-tint)' : 'var(--bg-1)',
        borderColor: active ? 'var(--accent)' : 'var(--line)',
        color: active ? 'var(--accent)' : 'var(--fg-2)',
        height: 22,
      }}
    >
      {children}
    </button>
  )
}

interface BoardFiltersProps {
  open: boolean
  filters: FilterState
  members: MemberOption[]
  labels: LabelOption[]
  currentUserId: string | null
  totalCards: number
  filteredCards: number
  searchQuery: string
  onFiltersChange: (f: FilterState) => void
  onSearchChange: (q: string) => void
  onClear: () => void
}

/**
 * BoardFilters renders a collapsible filter panel + active-filter chip bar.
 * It accepts pre-resolved members and labels lists. All filter state is
 * managed by the parent (board page). Does not fetch data; does not
 * manage its own open/close state.
 */
export function BoardFilters({
  open,
  filters,
  members,
  labels,
  currentUserId,
  totalCards,
  filteredCards,
  searchQuery,
  onFiltersChange,
  onSearchChange,
  onClear,
}: BoardFiltersProps) {
  const active = hasActiveFilters(filters) || searchQuery.trim().length > 0
  const showCount = active ? filteredCards : totalCards

  function toggleAssignee(id: string) {
    const next = filters.assignees.includes(id)
      ? filters.assignees.filter((a) => a !== id)
      : [...filters.assignees, id]
    onFiltersChange({ ...filters, assignees: next })
  }

  function togglePriority(p: Priority) {
    const next = filters.priorities.includes(p)
      ? filters.priorities.filter((x) => x !== p)
      : [...filters.priorities, p]
    onFiltersChange({ ...filters, priorities: next })
  }

  function toggleLabel(id: string) {
    const next = filters.labels.includes(id)
      ? filters.labels.filter((x) => x !== id)
      : [...filters.labels, id]
    onFiltersChange({ ...filters, labels: next })
  }

  return (
    <>
      {/* Sticky filter bar — always visible */}
      <div
        style={{
          height: 40,
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg-1)',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <span className="km-eyebrow" style={{ fontSize: 9 }}>filter</span>
        {/* Active filter chips inline */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden' }}>
          {filters.assignees.map((id) => {
            const m = members.find((x) => x.id === id)
            if (!m) return null
            return (
              <span
                key={id}
                className="km-chip km-chip--accent"
                style={{ cursor: 'pointer', gap: 4 }}
                onClick={() => toggleAssignee(id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleAssignee(id) }}
                aria-label={`Remove assignee filter: ${m.name}`}
              >
                {m.name.split(' ')[0].toLowerCase()}
                <X size={9} />
              </span>
            )
          })}
          {filters.priorities.map((p) => (
            <span
              key={p}
              className="km-chip"
              style={{ borderColor: PRIORITY_VARS[p], color: PRIORITY_VARS[p], cursor: 'pointer', gap: 4 }}
              onClick={() => togglePriority(p)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') togglePriority(p) }}
              aria-label={`Remove priority filter: ${p}`}
            >
              {p}
              <X size={9} />
            </span>
          ))}
          {filters.labels.map((id) => {
            const l = labels.find((x) => x.id === id)
            if (!l) return null
            return (
              <span
                key={id}
                className="km-chip"
                style={{ borderColor: l.color, color: l.color, cursor: 'pointer', gap: 4 }}
                onClick={() => toggleLabel(id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleLabel(id) }}
                aria-label={`Remove label filter: ${l.name}`}
              >
                {l.name}
                <X size={9} />
              </span>
            )
          })}
          {active && (
            <button
              className="km-btn km-btn--ghost km-btn--sm"
              onClick={onClear}
              style={{ height: 20, padding: '0 6px', fontSize: 10, color: 'var(--fg-3)' }}
            >
              clear
            </button>
          )}
        </div>
        <span
          className="km-mono"
          style={{ fontSize: 10, letterSpacing: '0.1em', color: active ? 'var(--fg-1)' : 'var(--fg-3)', textTransform: 'uppercase', flexShrink: 0 }}
        >
          {showCount} {active && totalCards !== filteredCards ? `/ ${totalCards} ` : ''}cards
        </span>
      </div>

      {/* Expandable panel */}
      {open && (
        <div
          role="region"
          aria-label="Filter options"
          style={{
            borderBottom: '1px solid var(--line)',
            background: 'var(--bg-1)',
            padding: '10px 24px',
            display: 'flex',
            gap: 24,
            flexWrap: 'wrap',
            flexShrink: 0,
          }}
        >
          {/* Assignee */}
          <div>
            <div className="km-eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>
              <ChevronDown size={9} style={{ display: 'inline', marginRight: 3 }} />
              assignee
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {currentUserId && (
                <ToggleChip
                  active={filters.assignees.includes(currentUserId)}
                  onClick={() => toggleAssignee(currentUserId)}
                >
                  me
                </ToggleChip>
              )}
              {members
                .filter((m) => m.id !== currentUserId)
                .map((m) => (
                  <ToggleChip
                    key={m.id}
                    active={filters.assignees.includes(m.id)}
                    onClick={() => toggleAssignee(m.id)}
                  >
                    {m.name.split(' ')[0].toLowerCase()}
                  </ToggleChip>
                ))}
            </div>
          </div>

          {/* Priority */}
          <div>
            <div className="km-eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>
              <ChevronDown size={9} style={{ display: 'inline', marginRight: 3 }} />
              priority
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {PRIORITY_OPTIONS.map(({ value, label }) => (
                <ToggleChip
                  key={value}
                  active={filters.priorities.includes(value)}
                  onClick={() => togglePriority(value)}
                >
                  <span style={{ color: PRIORITY_VARS[value], width: 6, height: 6, borderRadius: '50%', background: PRIORITY_VARS[value], flexShrink: 0, display: 'inline-block' }} />
                  {label}
                </ToggleChip>
              ))}
            </div>
          </div>

          {/* Labels */}
          {labels.length > 0 && (
            <div>
              <div className="km-eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>
                <ChevronDown size={9} style={{ display: 'inline', marginRight: 3 }} />
                labels
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {labels.map((l) => (
                  <ToggleChip
                    key={l.id}
                    active={filters.labels.includes(l.id)}
                    onClick={() => toggleLabel(l.id)}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 0, background: l.color, flexShrink: 0, display: 'inline-block' }} />
                    {l.name}
                  </ToggleChip>
                ))}
              </div>
            </div>
          )}

          {/* Search */}
          <div style={{ marginLeft: 'auto' }}>
            <div className="km-eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>search</div>
            <input
              type="search"
              className="km-input"
              placeholder="find a card…"
              value={searchQuery}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
              aria-label="Search cards"
              style={{ width: 180, height: 26, fontSize: 12 }}
            />
          </div>
        </div>
      )}
    </>
  )
}
