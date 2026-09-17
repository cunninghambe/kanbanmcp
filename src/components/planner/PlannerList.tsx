'use client'

import { useState } from 'react'
import { Eyebrow } from '@/components/design/Eyebrow'
import { PlannerItemRow } from './PlannerItemRow'
import { MeetingsStrip } from './MeetingsStrip'
import type { UsePlannerResult } from '@/hooks/usePlanner'
import type {
  PlannerAction,
  PlannerSection,
  RankedItemDTO,
  TodayResponse,
} from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §7.4 "PlannerList".

export interface PlannerListProps {
  data: TodayResponse
  selectedId: string | null
  onSelect: (id: string | null) => void
  act: UsePlannerResult['act']
}

interface ErrorEntry {
  message: string
  action: PlannerAction
  extra?: { snoozedUntil?: string }
}

const SECTION_ORDER: { key: PlannerSection; label: string }[] = [
  { key: 'now', label: 'now' },
  { key: 'today', label: 'today' },
  { key: 'soon', label: 'soon' },
  { key: 'later', label: 'later' },
  { key: 'snoozed', label: 'snoozed' },
  { key: 'done', label: 'done today' },
  { key: 'wont_do', label: "won't do" },
]

const NAV_SECTIONS: PlannerSection[] = ['now', 'today', 'soon', 'later', 'snoozed']

function isFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** `later today` (+3h), for the 's' keyboard shortcut's quick snooze. */
export function PlannerList({ data, selectedId, onSelect, act }: PlannerListProps) {
  const [showDismissed, setShowDismissed] = useState(false)
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<string | null>(null)
  const [actionErrors, setActionErrors] = useState<Map<string, ErrorEntry>>(new Map())

  const bySection = new Map<PlannerSection, RankedItemDTO[]>()
  for (const item of data.items) {
    const list = bySection.get(item.section)
    if (list) list.push(item)
    else bySection.set(item.section, [item])
  }

  const navItems = NAV_SECTIONS.flatMap((s) => bySection.get(s) ?? [])
  const meetings = data.items.filter((i) => i.source === 'calendar' && i.status === 'open')

  async function handleAct(
    itemId: string,
    action: PlannerAction,
    extra?: { snoozedUntil?: string }
  ) {
    const res = await act(itemId, action, extra)
    if (!res.ok) {
      setActionErrors((prev) => {
        const next = new Map(prev)
        next.set(itemId, { message: res.error ?? 'Action failed', action, extra })
        return next
      })
      return
    }
    const failed = res.writeThrough?.find((w) => w.ok === false)
    if (failed) {
      setActionErrors((prev) => {
        const next = new Map(prev)
        next.set(itemId, { message: failed.error, action, extra })
        return next
      })
      return
    }
    setActionErrors((prev) => {
      if (!prev.has(itemId)) return prev
      const next = new Map(prev)
      next.delete(itemId)
      return next
    })
  }

  function handleRetry(itemId: string) {
    const entry = actionErrors.get(itemId)
    if (!entry) return
    void handleAct(itemId, entry.action, entry.extra)
  }

  function handleDismissError(itemId: string) {
    setActionErrors((prev) => {
      if (!prev.has(itemId)) return prev
      const next = new Map(prev)
      next.delete(itemId)
      return next
    })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (isFormField(e.target)) return
    if (navItems.length === 0) return

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = selectedId ? navItems.findIndex((i) => i.id === selectedId) : -1
      let nextIdx: number
      if (idx === -1) nextIdx = 0
      else if (e.key === 'ArrowDown') nextIdx = Math.min(idx + 1, navItems.length - 1)
      else nextIdx = Math.max(idx - 1, 0)
      onSelect(navItems[nextIdx].id)
      return
    }

    if (!selectedId) return
    const selectedItem = navItems.find((i) => i.id === selectedId)
    if (!selectedItem) return

    if (e.key === 'd') {
      void handleAct(selectedId, 'done')
    } else if (e.key === 'x') {
      void handleAct(selectedId, 'dismiss')
    } else if (e.key === 'w') {
      void handleAct(selectedId, 'wont_do')
    } else if (e.key === 's') {
      // Opens the selected row's snooze menu (spec §1.1); the row reports
      // close/pick back through onSnoozeOpenChange.
      e.preventDefault()
      setSnoozeMenuFor(selectedId)
    }
  }

  return (
    <div
      role="group"
      aria-label="planner items"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{ display: 'flex', flexDirection: 'column', gap: 14, outline: 'none' }}
    >
      {meetings.length > 0 && (
        <section aria-label="meetings today">
          <Eyebrow size={9}>{'/// meetings today'}</Eyebrow>
          <div style={{ marginTop: 6 }}>
            <MeetingsStrip items={data.items} />
          </div>
        </section>
      )}

      {SECTION_ORDER.map(({ key, label }) => {
        const items = bySection.get(key) ?? []
        if (key !== 'now' && items.length === 0) return null
        return (
          <section aria-label={label} key={key}>
            <Eyebrow size={9}>{`/// ${label}`}</Eyebrow>
            {items.length === 0 ? (
              <div className="km-mono" style={{ fontSize: 12, color: 'var(--ok)', marginTop: 8 }}>
                ● nothing needs attention
              </div>
            ) : (
              <ul
                aria-label={`${label} items`}
                style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}
              >
                {items.map((item) => (
                  <PlannerItemRow
                    key={item.id}
                    item={item}
                    selected={item.id === selectedId}
                    onSelect={() => onSelect(item.id)}
                    onAct={(action, extra) => void handleAct(item.id, action, extra)}
                    error={actionErrors.get(item.id)?.message ?? null}
                    onRetry={() => handleRetry(item.id)}
                    onDismissError={() => handleDismissError(item.id)}
                    snoozeOpen={snoozeMenuFor === item.id}
                    onSnoozeOpenChange={(open) => setSnoozeMenuFor(open ? item.id : null)}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}

      <div>
        <button
          type="button"
          aria-pressed={showDismissed}
          onClick={() => setShowDismissed((v) => !v)}
          className="km-btn km-btn--ghost km-btn--sm"
        >
          show dismissed
        </button>
      </div>

      {showDismissed && (bySection.get('dismissed')?.length ?? 0) > 0 && (
        <section aria-label="dismissed">
          <Eyebrow size={9}>{'/// dismissed'}</Eyebrow>
          <ul
            aria-label="dismissed items"
            style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}
          >
            {(bySection.get('dismissed') ?? []).map((item) => (
              <PlannerItemRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={() => onSelect(item.id)}
                onAct={(action, extra) => void handleAct(item.id, action, extra)}
                error={actionErrors.get(item.id)?.message ?? null}
                onRetry={() => handleRetry(item.id)}
                onDismissError={() => handleDismissError(item.id)}
                snoozeOpen={snoozeMenuFor === item.id}
                onSnoozeOpenChange={(open) => setSnoozeMenuFor(open ? item.id : null)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
