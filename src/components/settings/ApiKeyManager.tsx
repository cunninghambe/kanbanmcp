'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface ApiKey {
  id: string
  agentName: string
  name: string
  permissions: string[]
  lastUsedAt: string | null
  createdAt: string
}

const PERMISSION_OPTIONS = ['read', 'write', 'admin']

export function ApiKeyManager() {
  const { data: keys, mutate } = useSWR<ApiKey[]>('/api/apikeys', fetcher)

  const [showCreate, setShowCreate] = useState(false)
  const [agentName, setAgentName] = useState('')
  const [selectedPerms, setSelectedPerms] = useState<string[]>(['read'])
  const [creating, setCreating] = useState(false)
  const [newKeyResult, setNewKeyResult] = useState<{ key: string; agentName: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const [revoking, setRevoking] = useState<string | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!agentName.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/apikeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentName: agentName.trim(), permissions: selectedPerms }),
      })
      if (res.ok) {
        const data = await res.json()
        setNewKeyResult({ key: data.key, agentName: data.agentName })
        setShowCreate(false)
        setAgentName('')
        setSelectedPerms(['read'])
        mutate()
      }
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(keyId: string) {
    if (!confirm('Revoke this API key? This cannot be undone.')) return
    setRevoking(keyId)
    try {
      await fetch(`/api/apikeys/${keyId}`, { method: 'DELETE' })
      mutate()
    } finally {
      setRevoking(null)
    }
  }

  function togglePerm(perm: string) {
    setSelectedPerms((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]
    )
  }

  async function copyKey() {
    if (!newKeyResult) return
    await navigator.clipboard.writeText(newKeyResult.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-900">API Keys</h2>
        <Button onClick={() => setShowCreate(true)}>New API Key</Button>
      </div>

      {/* Keys table */}
      {!keys || keys.length === 0 ? (
        <div className="text-center py-10 text-slate-400 text-sm border border-dashed border-slate-300 rounded-lg">
          No API keys yet. Create one to grant agents access.
        </div>
      ) : (
        <div className="overflow-hidden border border-slate-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Agent Name</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Permissions</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Last Used</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Created</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(Array.isArray(keys) ? keys : []).map((key) => (
                <tr key={key.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{key.agentName}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(key.permissions ?? []).map((p) => (
                        <Badge key={p}>{p}</Badge>
                      ))}
                      {(key.permissions ?? []).length === 0 && (
                        <span className="text-slate-400 text-xs">none</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleDateString()
                      : <span className="text-slate-300">Never</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(key.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleRevoke(key.id)}
                      disabled={revoking === key.id}
                    >
                      {revoking === key.id ? 'Revoking…' : 'Revoke'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setAgentName(''); setSelectedPerms(['read']) }}
        title="New API Key"
        size="sm"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Agent Name</label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="e.g. ci-agent"
              autoFocus
              required
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Permissions</label>
            <div className="space-y-2">
              {PERMISSION_OPTIONS.map((perm) => (
                <label key={perm} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedPerms.includes(perm)}
                    onChange={() => togglePerm(perm)}
                    className="rounded border-slate-300"
                  />
                  <span className="text-sm text-slate-700 capitalize">{perm}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setShowCreate(false); setAgentName(''); setSelectedPerms(['read']) }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !agentName.trim()}>
              {creating ? 'Creating…' : 'Create Key'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Key reveal modal */}
      <Modal
        open={!!newKeyResult}
        onClose={() => { setNewKeyResult(null); setCopied(false) }}
        title="API Key Created"
        size="md"
      >
        {newKeyResult && (
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
              <p className="text-sm font-medium text-amber-800">
                This key will only be shown once. Copy it now — you cannot retrieve it later.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
                Agent: {newKeyResult.agentName}
              </label>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-slate-100 px-3 py-2 rounded-md text-xs text-slate-800 font-mono break-all">
                  {newKeyResult.key}
                </code>
                <Button size="sm" variant="secondary" onClick={copyKey}>
                  {copied ? 'Copied!' : 'Copy'}
                </Button>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => { setNewKeyResult(null); setCopied(false) }}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
