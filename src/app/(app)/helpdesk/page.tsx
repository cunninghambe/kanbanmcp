'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { useSession } from '@/hooks/useSession'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  waiting: 'Waiting',
  resolved: 'Resolved',
  closed: 'Closed',
}

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-yellow-100 text-yellow-800',
  waiting: 'bg-purple-100 text-purple-800',
  resolved: 'bg-green-100 text-green-800',
  closed: 'bg-slate-100 text-slate-600',
}

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
}

interface Ticket {
  id: string
  number: number
  title: string
  status: string
  priority: string
  agentName: string | null
  createdAt: string
  reporter: { id: string; name: string; email: string } | null
  assignee: { id: string; name: string; email: string } | null
  _count: { comments: number }
}

export default function HelpdeskPage() {
  const router = useRouter()
  const { org } = useSession()
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newPriority, setNewPriority] = useState('medium')
  const [creating, setCreating] = useState(false)

  const params = new URLSearchParams()
  if (statusFilter) params.set('status', statusFilter)
  if (priorityFilter) params.set('priority', priorityFilter)
  params.set('limit', '50')

  const { data, mutate, isLoading } = useSWR(
    `/api/tickets?${params.toString()}`,
    fetcher
  )

  const tickets: Ticket[] = data?.tickets ?? []
  const total: number = data?.pagination?.total ?? 0

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newTitle.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle.trim(),
          description: newDesc.trim() || null,
          priority: newPriority,
        }),
      })
      if (res.ok) {
        const { ticket } = await res.json()
        setShowNew(false)
        setNewTitle('')
        setNewDesc('')
        setNewPriority('medium')
        mutate()
        router.push(`/helpdesk/${ticket.id}`)
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Header title="Helpdesk" />
      <main className="flex-1 p-6">
        <div className="max-w-6xl mx-auto">
          {/* Toolbar */}
          <div className="flex items-center justify-between mb-6 gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All Statuses</option>
                {Object.entries(STATUS_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All Priorities</option>
                {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <span className="text-sm text-slate-500">{total} ticket{total !== 1 ? 's' : ''}</span>
            </div>
            <Button onClick={() => setShowNew(true)}>New Ticket</Button>
          </div>

          {/* Ticket list */}
          {isLoading ? (
            <div className="text-center py-12 text-slate-500">Loading tickets…</div>
          ) : tickets.length === 0 ? (
            <div className="text-center py-16 text-slate-500">
              <p className="text-lg mb-2">No tickets found</p>
              <p className="text-sm mb-6">
                {statusFilter || priorityFilter
                  ? 'Try clearing your filters.'
                  : 'Create the first ticket to get started.'}
              </p>
              {!statusFilter && !priorityFilter && (
                <Button onClick={() => setShowNew(true)}>Create Ticket</Button>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
              {tickets.map((ticket) => (
                <button
                  key={ticket.id}
                  onClick={() => router.push(`/helpdesk/${ticket.id}`)}
                  className="w-full text-left px-5 py-4 hover:bg-slate-50 transition-colors group"
                >
                  <div className="flex items-start gap-3">
                    {/* Ticket number */}
                    <span className="text-xs font-mono text-slate-400 mt-0.5 shrink-0">
                      #{ticket.number}
                    </span>

                    {/* Main content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="font-medium text-slate-900 group-hover:text-blue-700 transition-colors truncate">
                          {ticket.title}
                        </h3>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-500">
                        <span>
                          {ticket.reporter
                            ? `by ${ticket.reporter.name}`
                            : ticket.agentName
                            ? `by agent ${ticket.agentName}`
                            : 'Unknown reporter'}
                        </span>
                        {ticket.assignee && (
                          <span>assigned to {ticket.assignee.name}</span>
                        )}
                        <span>{ticket._count.comments} comment{ticket._count.comments !== 1 ? 's' : ''}</span>
                        <span>{new Date(ticket.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>

                    {/* Badges */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_COLORS[ticket.priority] ?? 'bg-slate-100 text-slate-600'}`}>
                        {PRIORITY_LABELS[ticket.priority] ?? ticket.priority}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[ticket.status] ?? 'bg-slate-100 text-slate-600'}`}>
                        {STATUS_LABELS[ticket.status] ?? ticket.status}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* New Ticket Modal */}
      <Modal
        open={showNew}
        onClose={() => { setShowNew(false); setNewTitle(''); setNewDesc('') }}
        title="New Ticket"
        size="md"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Briefly describe the issue"
              autoFocus
              required
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Description
            </label>
            <textarea
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              rows={4}
              placeholder="Provide additional details…"
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Priority
            </label>
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setShowNew(false); setNewTitle(''); setNewDesc('') }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !newTitle.trim()}>
              {creating ? 'Creating…' : 'Create Ticket'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  )
}
