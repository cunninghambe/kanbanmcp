import type { ReactNode } from 'react'

interface EyebrowProps {
  children: ReactNode
  /** Override font size (px). Defaults to 11px (type-label-size). */
  size?: number
  className?: string
}

/**
 * Renders a mono UPPERCASE tracked-out label.
 * Used for section headings, sidebar group labels, and column names.
 */
export function Eyebrow({ children, size, className = '' }: EyebrowProps) {
  const style = size ? { fontSize: size } : undefined
  return (
    <span className={`km-eyebrow ${className}`} style={style}>
      {children}
    </span>
  )
}
