import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}

/**
 * Base button using design-token classes.
 * Public API is unchanged from before (variant + size props).
 * Maps legacy variants to km-btn token classes.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  disabled,
  ...props
}: ButtonProps) {
  const variantClass =
    variant === 'primary' ? 'km-btn km-btn--primary'
    : variant === 'ghost' ? 'km-btn km-btn--ghost'
    : variant === 'danger' ? 'km-btn km-btn--primary'   // danger maps to primary (accent = red)
    : 'km-btn'                                           // secondary

  const sizeClass = size === 'sm' ? 'km-btn--sm' : ''

  return (
    <button
      className={`${variantClass} ${sizeClass} ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`.trim()}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  )
}
