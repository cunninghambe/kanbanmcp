'use client'

import { Calendar } from 'lucide-react'
import type { RankedItemDTO } from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §7.1 "MeetingsStrip" — today's
// calendar items in time order, rendered as a horizontal strip.

export interface MeetingsStripProps {
  items: RankedItemDTO[]
}

function timeLabel(item: RankedItemDTO): string {
  if (!item.startsAt) return ''
  const start = new Date(item.startsAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  if (!item.endsAt) return start
  const end = new Date(item.endsAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return `${start}–${end}`
}

export function MeetingsStrip({ items }: MeetingsStripProps) {
  const meetings = items
    .filter((i) => i.source === 'calendar' && i.status === 'open')
    .sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''))

  if (meetings.length === 0) return null

  return (
    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
      {meetings.map((m) => (
        <div
          key={m.id}
          style={{
            flexShrink: 0,
            minWidth: 140,
            border: '1px solid var(--line)',
            background: 'var(--bg-1)',
            padding: '6px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span
            className="km-mono"
            style={{
              fontSize: 10,
              color: 'var(--fg-3)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Calendar size={11} /> {timeLabel(m)}
          </span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--fg-0)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {m.title}
          </span>
        </div>
      ))}
    </div>
  )
}
