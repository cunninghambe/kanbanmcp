export type Priority = 'critical' | 'high' | 'medium' | 'low' | 'none'

const priorityClass: Record<Priority, string> = {
  critical: 'km-kc--prio-critical',
  high: 'km-kc--prio-high',
  medium: 'km-kc--prio-medium',
  low: 'km-kc--prio-low',
  none: '',
}

/**
 * Returns the CSS class string to apply to a `.km-kc` card element
 * to render the 3px left-edge priority color bar.
 *
 * Usage: apply the returned class alongside `km-kc` on the card wrapper.
 */
export function getPriorityClass(priority: string): string {
  return priorityClass[(priority as Priority) ?? 'none'] ?? ''
}

interface PriorityBarProps {
  /** Priority level — controls color */
  level: string
}

/**
 * Inline 3px × 12px priority bar used inside card meta rows.
 * The canonical card-level priority bar is rendered via box-shadow
 * (via `getPriorityClass`). This component is for inline display.
 */
export function PriorityBar({ level }: PriorityBarProps) {
  const colors: Record<string, string> = {
    critical: 'var(--p-critical)',
    high: 'var(--p-high)',
    medium: 'var(--p-medium)',
    low: 'var(--p-low)',
  }
  const bg = colors[level]
  if (!bg) return null
  return (
    <span
      title={`Priority: ${level}`}
      aria-label={`Priority: ${level}`}
      style={{ display: 'inline-block', width: 3, height: 12, background: bg, flexShrink: 0 }}
    />
  )
}
