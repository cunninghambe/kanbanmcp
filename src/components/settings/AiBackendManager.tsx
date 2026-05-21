'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/design/Chip'
import { Eyebrow } from '@/components/design/Eyebrow'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface AiSettingsResponse {
  anthropicApiKey: {
    configured: boolean
    lastFour: string | null
  }
}

interface Props {
  orgId: string
  isAdmin: boolean
}

export function AiBackendManager({ orgId, isAdmin }: Props) {
  const { data, mutate } = useSWR<AiSettingsResponse>(
    `/api/orgs/${orgId}/ai-settings`,
    fetcher
  )

  const [editing, setEditing] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const configured = data?.anthropicApiKey?.configured ?? false
  const lastFour = data?.anthropicApiKey?.lastFour ?? null

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!keyInput.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/orgs/${orgId}/ai-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anthropicApiKey: keyInput.trim() }),
      })
      if (res.ok) {
        setEditing(false)
        setKeyInput('')
        mutate()
      } else {
        const body = await res.json()
        setError((body as { error?: string }).error ?? 'Failed to save key')
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleClear() {
    if (!confirm('Remove the stored Anthropic API key?')) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/orgs/${orgId}/ai-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anthropicApiKey: null }),
      })
      if (res.ok) {
        mutate()
      } else {
        const body = await res.json()
        setError((body as { error?: string }).error ?? 'Failed to clear key')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--fg-0)' }}>
            AI Backend
          </h2>
          <p className="text-sm mt-1" style={{ color: 'var(--fg-3)' }}>
            Anthropic API key fallback. Used when ClaudeMCP cannot handle a request (e.g. image artifacts).
          </p>
        </div>
        {isAdmin && configured && !editing && (
          <Button size="sm" onClick={() => setEditing(true)}>Update</Button>
        )}
        {isAdmin && !configured && !editing && (
          <Button size="sm" onClick={() => setEditing(true)}>Configure</Button>
        )}
      </div>

      <div
        style={{
          border: '1px solid var(--line)',
          background: 'var(--bg-2)',
          padding: '16px',
        }}
      >
        <Eyebrow size={10}>Anthropic API Key</Eyebrow>

        {!editing && (
          <div className="flex items-center gap-3 mt-2">
            {configured && lastFour ? (
              <>
                <code className="km-mono text-sm" style={{ color: 'var(--fg-0)' }}>
                  sk-ant-…{lastFour}
                </code>
                <Chip tone="ok">configured</Chip>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={handleClear}
                    disabled={saving}
                  >
                    Clear
                  </Button>
                )}
              </>
            ) : (
              <span className="text-sm" style={{ color: 'var(--fg-3)' }}>
                Not configured
              </span>
            )}
          </div>
        )}

        {editing && (
          <form onSubmit={handleSave} className="mt-3 space-y-3">
            {error && (
              <div
                style={{
                  border: '1px solid var(--err)',
                  color: 'var(--err)',
                  padding: '8px 12px',
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            )}
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk-ant-api03-…"
              autoFocus
              autoComplete="off"
              required
              className="km-input"
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={saving || !keyInput.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEditing(false)
                  setKeyInput('')
                  setError(null)
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
