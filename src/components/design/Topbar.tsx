import type { ReactNode } from 'react'
import { Chip } from './Chip'

interface TopbarProps {
  title: string
  breadcrumb?: string
  /** Optional right-side slot for action buttons / controls */
  right?: ReactNode
  /** When 'board', shows the active sprint chip next to the title */
  mode?: 'board' | 'default'
  /** Sprint label shown in the chip when mode='board' */
  sprintLabel?: string
}

/**
 * App topbar — 56px fixed-height header with breadcrumb eyebrow, page title,
 * an optional sprint chip (board mode), and a right-side action slot.
 * Does not manage navigation state.
 */
export function Topbar({ title, breadcrumb, right, mode = 'default', sprintLabel }: TopbarProps) {
  return (
    <header
      style={{
        height: 56,
        borderBottom: '1px solid var(--line)',
        background: 'var(--bg-1)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 24px',
        gap: 16,
        flexShrink: 0,
      }}
    >
      <div className="flex-1 min-w-0">
        {breadcrumb && (
          <div
            className="km-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              color: 'var(--fg-3)',
              textTransform: 'uppercase',
              marginBottom: 2,
            }}
          >
            {breadcrumb}
          </div>
        )}
        <div className="flex items-center gap-3">
          <h1
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--fg-0)',
              letterSpacing: '-0.01em',
              margin: 0,
            }}
          >
            {title}
          </h1>
          {mode === 'board' && (
            <Chip>
              <span className="km-pip km-pip--ok" />
              {sprintLabel ?? 'active sprint'}
            </Chip>
          )}
        </div>
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </header>
  )
}
