'use client'

import { Sun, Moon, Monitor } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import type { ThemeChoice } from '@/hooks/useTheme'

const CYCLE: ThemeChoice[] = ['system', 'light', 'dark']

const LABELS: Record<ThemeChoice, string> = {
  system: 'system',
  light: 'light',
  dark: 'dark',
}

const ICONS: Record<ThemeChoice, React.ReactNode> = {
  system: <Monitor size={13} />,
  light: <Sun size={13} />,
  dark: <Moon size={13} />,
}

/**
 * Three-state theme toggle: system → light → dark → system.
 * Rendered as a ghost button showing the current mode icon + label.
 * Calls useTheme to persist choice in localStorage and update data-theme.
 * Does not manage layout or positioning.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  function handleClick() {
    const idx = CYCLE.indexOf(theme)
    const next = CYCLE[(idx + 1) % CYCLE.length]
    setTheme(next)
  }

  return (
    <button
      className="km-btn km-btn--ghost km-btn--sm"
      onClick={handleClick}
      aria-label={`Theme: ${LABELS[theme]}. Click to cycle.`}
      title={`Theme: ${LABELS[theme]}`}
      style={{ gap: 5, color: 'var(--fg-3)', width: '100%', justifyContent: 'flex-start' }}
    >
      {ICONS[theme]}
      <span className="km-mono" style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        {LABELS[theme]}
      </span>
    </button>
  )
}
