export type PipTone = 'ok' | 'warn' | 'err' | 'accent' | 'default'

interface PipProps {
  tone?: PipTone
  title?: string
}

/**
 * 7×7px square status indicator.
 * Used inline in cards, column headers, and chip labels.
 */
export function Pip({ tone = 'default', title }: PipProps) {
  const cls = tone !== 'default' ? `km-pip km-pip--${tone}` : 'km-pip'
  return <span className={cls} title={title} aria-label={title} />
}
