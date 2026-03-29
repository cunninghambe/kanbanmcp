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
        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium text-white ${className}`}
        style={{ backgroundColor: color }}
      >
        {children}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 ${className}`}
    >
      {children}
    </span>
  )
}
