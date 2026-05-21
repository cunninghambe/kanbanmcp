import type { ReactNode } from 'react'

interface KVProps {
  /** Label shown in the left column, rendered as mono eyebrow */
  label: string
  /** Value content — string or any inline React */
  children: ReactNode
  /** If true, the row gets the accent-tint background */
  accent?: boolean
}

/**
 * Mono key/value block for the right-rail metadata sections.
 * 92px label column, flexible value column, hairline bottom border.
 */
export function KV({ label, children, accent = false }: KVProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '92px 1fr',
        gap: 12,
        alignItems: 'center',
        padding: '10px 16px',
        borderBottom: '1px solid var(--line-faint)',
        background: accent ? 'var(--accent-tint)' : undefined,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--fg-3)',
          fontWeight: 500,
        }}
      >
        {label}
      </span>
      <div
        style={{
          fontSize: 13,
          color: 'var(--fg-1)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        {children}
      </div>
    </div>
  )
}
