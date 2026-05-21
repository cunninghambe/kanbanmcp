'use client'

import { useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'kanban-theme'

function getInitialTheme(): ThemeChoice {
  if (typeof window === 'undefined') return 'system'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return 'system'
}

function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'dark') {
    root.setAttribute('data-theme', 'dark')
  } else if (choice === 'light') {
    root.setAttribute('data-theme', 'light')
  } else {
    // system: remove explicit attribute so CSS @media takes over
    root.removeAttribute('data-theme')
    // Re-apply dark if OS prefers it (inline script already did this on
    // first load, but after a system→light→system cycle we need to re-check)
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.setAttribute('data-theme', 'dark')
    }
  }
}

export function useTheme(): { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void } {
  const [theme, setThemeState] = useState<ThemeChoice>(getInitialTheme)

  useEffect(() => {
    applyTheme(theme)
    if (theme === 'system') {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, theme)
    }
  }, [theme])

  // Keep in sync when OS preference changes while on "system"
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    function handleChange() {
      if (getInitialTheme() === 'system') {
        applyTheme('system')
      }
    }
    mq.addEventListener('change', handleChange)
    return () => mq.removeEventListener('change', handleChange)
  }, [])

  function setTheme(choice: ThemeChoice) {
    setThemeState(choice)
  }

  return { theme, setTheme }
}
