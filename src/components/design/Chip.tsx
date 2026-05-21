import type { ReactNode } from 'react'
import { Pip } from './Pip'
import type { PipTone } from './Pip'

// Re-export so callers can type the tone prop
export type { PipTone }

type ChipTone = 'ok' | 'warn' | 'err' | 'accent' | 'accent-solid'

interface ChipProps {
  children: ReactNode
  tone?: ChipTone
  /** If true, prepend a pip with the matching tone */
  dot?: boolean
  className?: string
}

const toneClass: Record<ChipTone, string> = {
  ok: 'km-chip--ok',
  warn: 'km-chip--warn',
  err: 'km-chip--err',
  accent: 'km-chip--accent',
  'accent-solid': 'km-chip--solid-accent',
}

/**
 * Compact mono chip for status/filter labels.
 * Matches the `.km-chip` CSS class with optional tone variants.
 */
export function Chip({ children, tone, dot, className = '' }: ChipProps) {
  const cls = `km-chip${tone ? ` ${toneClass[tone]}` : ''} ${className}`.trim()
  const pipTone: PipTone = tone === 'accent-solid' ? 'accent' : (tone as PipTone | undefined) ?? 'default'
  return (
    <span className={cls}>
      {dot && <Pip tone={pipTone} />}
      {children}
    </span>
  )
}
