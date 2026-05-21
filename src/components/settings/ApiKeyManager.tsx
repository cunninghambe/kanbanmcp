'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Chip } from '@/components/design/Chip'
import { Eyebrow } from '@/components/design/Eyebrow'

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
        <h2 className="text-lg font-semibold" style={{ color: 'var(--fg-0)' }}>API Keys</h2>
        <Button onClick={() => setShowCreate(true)}>New API Key</Button>
      </div>

      {/* Keys table */}
      {!keys || keys.length === 0 ? (
        <div
          className="text-center py-10 text-sm"
          style={{ color: 'var(--fg-3)', border: '1px dashed var(--line-strong)' }}
        >
          No API keys yet. Create one to grant agents access.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--line)', overflow: 'hidden' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--line)' }}>
              <tr>
                <th className="text-left px-4 py-3">
                  <Eyebrow size={10}>Agent Name</Eyebrow>
                </th>
                <th className="text-left px-4 py-3">
                  <Eyebrow size={10}>Permissions</Eyebrow>
                </th>
                <th className="text-left px-4 py-3">
                  <Eyebrow size={10}>Last Used</Eyebrow>
                </th>
                <th className="text-left px-4 py-3">
                  <Eyebrow size={10}>Created</Eyebrow>
                </th>
                <th className="text-right px-4 py-3">
                  <Eyebrow size={10}>Actions</Eyebrow>
                </th>
              </tr>
            </thead>
            <tbody>
              {(Array.isArray(keys) ? keys : []).map((key, i) => (
                <tr
                  key={key.id}
                  style={{
                    borderTop: i === 0 ? 'none' : '1px solid var(--line)',
                    background: 'var(--bg-1)',
                  }}
                >
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--fg-0)' }}>
                    {key.agentName}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(key.permissions ?? []).map((p) => (
                        <Chip key={p}>{p}</Chip>
                      ))}
                      {(key.permissions ?? []).length === 0 && (
                        <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>none</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 km-mono" style={{ color: 'var(--fg-2)', fontSize: 12 }}>
                    {key.lastUsedAt ? (
                      new Date(key.lastUsedAt).toLocaleDateString()
                    ) : (
                      <span style={{ color: 'var(--fg-4)' }}>Never</span>
                    )}
                  </td>
                  <td className="px-4 py-3 km-mono" style={{ color: 'var(--fg-2)', fontSize: 12 }}>
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
        onClose={() => {
          setShowCreate(false)
          setAgentName('')
          setSelectedPerms(['read'])
        }}
        title="New API Key"
        size="sm"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--fg-1)' }}>
              Agent Name
            </label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="e.g. ci-agent"
              autoFocus
              required
              className="km-input"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--fg-1)' }}>
              Permissions
            </label>
            <div className="space-y-2">
              {PERMISSION_OPTIONS.map((perm) => (
                <label key={perm} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedPerms.includes(perm)}
                    onChange={() => togglePerm(perm)}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span className="text-sm capitalize" style={{ color: 'var(--fg-1)' }}>{perm}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setShowCreate(false)
                setAgentName('')
                setSelectedPerms(['read'])
              }}
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
        onClose={() => {
          setNewKeyResult(null)
          setCopied(false)
        }}
        title="API Key Created"
        size="md"
      >
        {newKeyResult && (
          <div className="space-y-4">
            <div
              style={{
                border: '1px solid var(--warn)',
                padding: '12px',
              }}
            >
              <p className="text-sm font-medium" style={{ color: 'var(--warn)' }}>
                This key will only be shown once. Copy it now — you cannot retrieve it later.
              </p>
            </div>
            <div>
              <label
                className="block text-xs font-medium uppercase tracking-wide mb-1"
                style={{ color: 'var(--fg-2)' }}
              >
                Agent: {newKeyResult.agentName}
              </label>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 km-mono text-xs break-all px-3 py-2"
                  style={{
                    background: 'var(--bg-3)',
                    color: 'var(--fg-0)',
                    border: '1px solid var(--line)',
                  }}
                >
                  {newKeyResult.key}
                </code>
                <Button size="sm" variant="secondary" onClick={copyKey}>
                  {copied ? 'Copied!' : 'Copy'}
                </Button>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setNewKeyResult(null)
                  setCopied(false)
                }}
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
