import { Sparkles } from 'lucide-react'

type AvatarSize = 'sm' | 'md' | 'lg'

interface AvatarProps {
  /** Display name used to derive initials */
  name?: string
  size?: AvatarSize
  /** Override background color */
  color?: string
  /** If true, renders an AI avatar (signal-red bg + sparkle icon) */
  ai?: boolean
}

const sizeClass: Record<AvatarSize, string> = {
  sm: 'avatar avatar--sm',
  md: 'avatar',
  lg: 'avatar avatar--lg',
}

const iconSize: Record<AvatarSize, number> = {
  sm: 9,
  md: 11,
  lg: 14,
}

/**
 * Circle avatar showing initials or an AI sparkle icon.
 * Uses the `.avatar` CSS class from design-tokens.css.
 */
export function Avatar({ name, size = 'md', color, ai = false }: AvatarProps) {
  const initials = (name ?? '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  const cls = sizeClass[size]
  const style: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-pill)',
    flexShrink: 0,
    background: ai ? 'var(--accent)' : color ?? 'var(--fg-1)',
    color: ai ? 'var(--fg-inverse)' : 'var(--bg-0)',
    fontFamily: 'var(--font-mono)',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    ...(size === 'sm' ? { width: 18, height: 18, fontSize: 8 }
      : size === 'lg' ? { width: 32, height: 32, fontSize: 12 }
      : { width: 24, height: 24, fontSize: 10 }),
  }

  if (ai) {
    return (
      <span className={cls} title="AI Reviewer" style={style} aria-label="AI Reviewer">
        <Sparkles size={iconSize[size]} strokeWidth={1.75} color="#fff" />
      </span>
    )
  }

  return (
    <span className={cls} title={name} style={style} aria-label={name}>
      {initials}
    </span>
  )
}
