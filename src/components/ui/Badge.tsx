import { ReactNode } from 'react'

interface BadgeProps {
  children: ReactNode
  color?: string
  variant?: 'default' | 'colored'
  className?: string
}

export function Badge({ children, color, variant = 'default', className = '' }: BadgeProps) {
  if (variant === 'colored' && color) {
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 text-xs font-medium text-white ${className}`}
        style={{ backgroundColor: color }}
      >
        {children}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-medium ${className}`}
      style={{
        background: 'var(--bg-3)',
        color: 'var(--fg-1)',
        border: '1px solid var(--line)',
      }}
    >
      {children}
    </span>
  )
}
