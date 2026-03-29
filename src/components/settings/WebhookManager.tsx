'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface Webhook {
  id: string
  url: string
  events: string[]
  active: boolean
  createdAt: string
}

const ALLOWED_EVENTS = [
  'card.created',
  'card.updated',
  'card.moved',
  'sprint.started',
  'sprint.completed',
]

export function WebhookManager() {
  const { data: webhooks, mutate } = useSWR<Webhook[]>('/api/webhooks', fetcher)

  const [showCreate, setShowCreate] = useState(false)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['card.created'])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [deleting, setDeleting] = useState<string | null>(null)
  const [pinging, setPinging] = useState<string | null>(null)
  const [pingResult, setPingResult] = useState<{ id: string; ok: boolean } | null>(null)

  function toggleEvent(event: string) {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    )
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim() || !secret.trim() || selectedEvents.length === 0) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), events: selectedEvents, secret: secret.trim() }),
      })
      if (res.ok) {
        setShowCreate(false)
        setUrl('')
        setSecret('')
        setSelectedEvents(['card.created'])
        mutate()
      } else {
        const data = await res.json()
        setCreateError(data.error ?? 'Failed to create webhook')
      }
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(webhookId: string) {
    if (!confirm('Delete this webhook?')) return
    setDeleting(webhookId)
    try {
      await fetch(`/api/webhooks/${webhookId}`, { method: 'DELETE' })
      mutate()
    } finally {
      setDeleting(null)
    }
  }

  async function handleTestPing(webhook: Webhook) {
    setPinging(webhook.id)
    setPingResult(null)
    try {
      const res = await fetch(`/api/webhooks/${webhook.id}/test`, { method: 'POST' })
      const data = await res.json()
      setPingResult({ id: webhook.id, ok: res.ok && data.ok })
    } catch {
      setPingResult({ id: webhook.id, ok: false })
    } finally {
      setPinging(null)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-900">Webhooks</h2>
        <Button onClick={() => setShowCreate(true)}>Add Webhook</Button>
      </div>

      {!webhooks || webhooks.length === 0 ? (
        <div className="text-center py-10 text-slate-400 text-sm border border-dashed border-slate-300 rounded-lg">
          No webhooks registered yet.
        </div>
      ) : (
        <div className="space-y-3">
          {(Array.isArray(webhooks) ? webhooks : []).map((wh) => (
            <div
              key={wh.id}
              className="border border-slate-200 rounded-lg p-4 bg-white"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{wh.url}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(wh.events ?? []).map((evt) => (
                      <Badge key={evt}>{evt}</Badge>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`text-xs font-medium ${wh.active ? 'text-green-600' : 'text-slate-400'}`}>
                    {wh.active ? 'Active' : 'Inactive'}
                  </span>
                  {pingResult?.id === wh.id && (
                    <span className={`text-xs font-medium ${pingResult.ok ? 'text-green-600' : 'text-red-600'}`}>
                      {pingResult.ok ? 'Ping OK' : 'Ping failed'}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleTestPing(wh)}
                    disabled={pinging === wh.id}
                  >
                    {pinging === wh.id ? 'Pinging…' : 'Test Ping'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => handleDelete(wh.id)}
                    disabled={deleting === wh.id}
                  >
                    {deleting === wh.id ? 'Deleting…' : 'Delete'}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setUrl(''); setSecret(''); setSelectedEvents(['card.created']); setCreateError(null) }}
        title="Add Webhook"
        size="md"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {createError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
              {createError}
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Endpoint URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              autoFocus
              required
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Secret</label>
            <input
              type="text"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Shared secret for HMAC signature verification"
              required
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Events</label>
            <div className="space-y-2">
              {ALLOWED_EVENTS.map((evt) => (
                <label key={evt} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(evt)}
                    onChange={() => toggleEvent(evt)}
                    className="rounded border-slate-300"
                  />
                  <span className="text-sm text-slate-700 font-mono">{evt}</span>
                </label>
              ))}
            </div>
            {selectedEvents.length === 0 && (
              <p className="text-xs text-red-600 mt-1">Select at least one event</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setShowCreate(false); setUrl(''); setSecret(''); setSelectedEvents(['card.created']); setCreateError(null) }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={creating || !url.trim() || !secret.trim() || selectedEvents.length === 0}
            >
              {creating ? 'Adding…' : 'Add Webhook'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
