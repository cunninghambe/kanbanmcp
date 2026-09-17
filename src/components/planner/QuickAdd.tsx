'use client'

import { useState } from 'react'

// Spec: docs/specs/mhud-today-planner.md §7.1 / §7.4.

export interface QuickAddProps {
  onAdd: (title: string) => Promise<{ ok: boolean; error?: string }>
}

export function QuickAdd({ onAdd }: QuickAddProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    const title = value.trim()
    if (!title || busy) return
    setBusy(true)
    setError(null)
    const res = await onAdd(title)
    setBusy(false)
    if (res.ok) {
      setValue('')
    } else {
      setError(res.error ?? 'Could not add that')
    }
  }

  return (
    <div style={{ padding: '10px 12px', borderTop: '1px solid var(--line)' }}>
      <input
        aria-label="Quick add"
        placeholder="quick add a to-do…"
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
        }}
        className="km-input"
        style={{ fontSize: 13 }}
      />
      {error && (
        <div
          role="alert"
          className="km-mono"
          style={{ fontSize: 10, color: 'var(--err)', marginTop: 4 }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
