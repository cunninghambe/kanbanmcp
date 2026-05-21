import type { ReactNode } from 'react'

type StatTileAccent = 'err' | 'ok' | 'warn' | 'default'

interface StatTileProps {
  label: string
  value: string | number
  sub?: string
  accent?: StatTileAccent
  /** Optional right-side content slot (e.g. pip legend) */
  extra?: ReactNode
  /** If true, renders a border-right hairline (for tiles in a row) */
  divider?: boolean
}

/**
 * A stat tile with a mono UPPERCASE label, display-font number,
 * and a muted sub-caption. Used in the dashboard stats row.
 * Sharp corners, no border-radius. Does not fetch data.
 */
export function StatTile({ label, value, sub, accent = 'default', extra, divider = true }: StatTileProps) {
  const valueColor =
    accent === 'err'
      ? 'var(--err)'
      : accent === 'ok'
        ? 'var(--ok)'
        : accent === 'warn'
          ? 'var(--warn)'
          : 'var(--fg-0)'

  return (
    <div
      style={{
        padding: '16px 18px',
        borderRight: divider ? '1px solid var(--line)' : 'none',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <span
        className="km-eyebrow"
        style={{ fontSize: 9 }}
      >
        {label}
      </span>
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 32,
          fontWeight: 600,
          letterSpacing: '-0.025em',
          color: valueColor,
          marginTop: 6,
          lineHeight: 1,
        }}
      >
        {typeof value === 'number' ? String(value).padStart(2, '0') : value}
      </div>
      {sub && (
        <div
          className="km-mono"
          style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 6, letterSpacing: '0.06em' }}
        >
          {sub}
        </div>
      )}
      {extra && <div style={{ marginTop: 6 }}>{extra}</div>}
    </div>
  )
}
