'use client'

import { useState } from 'react'

// Spec: docs/specs/mhud-today-planner.md §7.3 "SnoozeMenu" / §7.4.

export interface SnoozeOption {
  key: 'later_today' | 'tomorrow' | 'next_monday'
  label: string
  at: Date
}

function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDaysLocal(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function nextMondayAfter(now: Date): Date {
  const day = now.getDay() // 0 = Sunday .. 6 = Saturday
  let delta = (8 - day) % 7
  if (delta === 0) delta = 7 // today is Monday: next monday is a week out, never today
  return addDaysLocal(localMidnight(now), delta)
}

export function snoozeOptions(now: Date): SnoozeOption[] {
  const tomorrow = addDaysLocal(localMidnight(now), 1)
  tomorrow.setHours(9, 0, 0, 0)
  const monday = nextMondayAfter(now)
  monday.setHours(9, 0, 0, 0)
  return [
    { key: 'later_today', label: 'later today', at: new Date(now.getTime() + 3 * 3600_000) },
    { key: 'tomorrow', label: 'tomorrow 9:00', at: tomorrow },
    { key: 'next_monday', label: 'next monday 9:00', at: monday },
  ]
}

export interface SnoozeMenuProps {
  onPick: (snoozedUntilIso: string) => void
  onClose: () => void
  now?: () => Date
}

export function SnoozeMenu({ onPick, onClose, now }: SnoozeMenuProps) {
  const [custom, setCustom] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const options = snoozeOptions(now ? now() : new Date())

  function handleCustomSubmit() {
    if (!customValue) return
    const d = new Date(customValue)
    if (Number.isNaN(d.getTime())) return
    onPick(d.toISOString())
  }

  return (
    <div
      role="menu"
      aria-label="Snooze until"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
      style={{
        position: 'absolute',
        zIndex: 20,
        marginTop: 4,
        border: '1px solid var(--line-strong)',
        background: 'var(--bg-1)',
        boxShadow: '0 8px 24px -16px rgba(0,0,0,0.4)',
        minWidth: 160,
        display: 'flex',
        flexDirection: 'column',
        padding: 4,
      }}
    >
      {!custom &&
        options.map((o) => (
          <button
            key={o.key}
            role="menuitem"
            type="button"
            onClick={() => onPick(o.at.toISOString())}
            className="km-mono"
            style={{
              textAlign: 'left',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '6px 8px',
              fontSize: 12,
              color: 'var(--fg-1)',
            }}
          >
            {o.label}
          </button>
        ))}
      {!custom && (
        <button
          role="menuitem"
          type="button"
          onClick={() => setCustom(true)}
          className="km-mono"
          style={{
            textAlign: 'left',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '6px 8px',
            fontSize: 12,
            color: 'var(--fg-2)',
          }}
        >
          custom…
        </button>
      )}
      {custom && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 4 }}>
          <input
            type="datetime-local"
            aria-label="Snooze until"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            className="km-input"
            style={{ fontSize: 12, height: 28 }}
          />
          <button
            type="button"
            onClick={handleCustomSubmit}
            className="km-btn km-btn--primary km-btn--sm"
          >
            snooze
          </button>
        </div>
      )}
    </div>
  )
}
