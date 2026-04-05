'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import useSWR from 'swr'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/Button'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
]

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-100 text-blue-800 border-blue-200',
  in_progress: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  waiting: 'bg-purple-100 text-purple-800 border-purple-200',
  resolved: 'bg-green-100 text-green-800 border-green-200',
  closed: 'bg-slate-100 text-slate-600 border-slate-200',
}

const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
}

const ACTION_LABELS: Record<string, string> = {
  created: 'created this ticket',
  status_changed: 'changed status',
  priority_changed: 'changed priority',
  title_changed: 'changed title',
  assigned: 'changed assignee',
  commented: 'left a comment',
}

interface TicketUser {
  id: string
  name: string
  email: string
}

interface TicketComment {
  id: string
  content: string
  internal: boolean
  agentName: string | null
  createdAt: string
  user: TicketUser | null
}

interface TicketActivityEntry {
  id: string
  action: string
  fromValue: string | null
  toValue: string | null
  agentName: string | null
  createdAt: string
  user: TicketUser | null
}

interface TicketDetail {
  id: string
  number: number
  title: string
  description: string | null
  status: string
  priority: string
  agentName: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  closedAt: string | null
  reporter: TicketUser | null
  assignee: TicketUser | null
  comments: TicketComment[]
  activity: TicketActivityEntry[]
}

function AuthorLabel({ user, agentName }: { user: TicketUser | null; agentName: string | null }) {
  if (user) return <span className="font-medium">{user.name}</span>
  if (agentName) return <span className="font-medium text-purple-700">{agentName} (agent)</span>
  return <span className="font-medium text-slate-400">Unknown</span>
}

export default function TicketDetailPage() {
  const params = useParams()
  const router = useRouter()
  const ticketId = params.ticketId as string

  const { data, mutate, isLoading } = useSWR(`/api/tickets/${ticketId}`, fetcher)
  const ticket: TicketDetail | null = data?.ticket ?? null

  const [commentText, setCommentText] = useState('')
  const [commentInternal, setCommentInternal] = useState(false)
  const [submittingComment, setSubmittingComment] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  async function patch(body: Record<string, unknown>) {
    setSaving(true)
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) await mutate()
    } finally {
      setSaving(false)
    }
  }

  async function submitComment(e: React.FormEvent) {
    e.preventDefault()
    if (!commentText.trim()) return
    setSubmittingComment(true)
    try {
      const res = await fetch(`/api/tickets/${ticketId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: commentText.trim(), internal: commentInternal }),
      })
      if (res.ok) {
        setCommentText('')
        setCommentInternal(false)
        await mutate()
      }
    } finally {
      setSubmittingComment(false)
    }
  }

  async function handleDelete() {
    const res = await fetch(`/api/tickets/${ticketId}`, { method: 'DELETE' })
    if (res.ok) router.push('/helpdesk')
  }

  async function saveTitle() {
    if (titleDraft.trim() && titleDraft !== ticket?.title) {
      await patch({ title: titleDraft.trim() })
    }
    setEditingTitle(false)
  }

  async function saveDesc() {
    await patch({ description: descDraft.trim() || null })
    setEditingDesc(false)
  }

  if (isLoading) {
    return (
      <>
        <Header breadcrumbs={[{ label: 'Helpdesk', href: '/helpdesk' }, { label: 'Loading…' }]} />
        <main className="flex-1 p-6 flex items-center justify-center text-slate-500">Loading…</main>
      </>
    )
  }

  if (!ticket) {
    return (
      <>
        <Header breadcrumbs={[{ label: 'Helpdesk', href: '/helpdesk' }, { label: 'Not found' }]} />
        <main className="flex-1 p-6">
          <div className="max-w-4xl mx-auto text-center py-16 text-slate-500">
            <p className="text-lg">Ticket not found.</p>
            <Button className="mt-4" onClick={() => router.push('/helpdesk')}>Back to Helpdesk</Button>
          </div>
        </main>
      </>
    )
  }

  const allEvents: Array<{ type: 'comment' | 'activity'; createdAt: string; data: TicketComment | TicketActivityEntry }> = [
    ...ticket.comments.map((c) => ({ type: 'comment' as const, createdAt: c.createdAt, data: c })),
    ...ticket.activity.map((a) => ({ type: 'activity' as const, createdAt: a.createdAt, data: a })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  return (
    <>
      <Header
        breadcrumbs={[
          { label: 'Helpdesk', href: '/helpdesk' },
          { label: `#${ticket.number} ${ticket.title}` },
        ]}
      />
      <main className="flex-1 p-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex gap-6">
            {/* Main column */}
            <div className="flex-1 min-w-0 space-y-6">
              {/* Title */}
              <div>
                {editingTitle ? (
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditingTitle(false) }}
                      className="flex-1 text-2xl font-bold text-slate-900 border-b-2 border-blue-500 focus:outline-none bg-transparent"
                    />
                    <Button size="sm" onClick={saveTitle} disabled={saving}>Save</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditingTitle(false)}>Cancel</Button>
                  </div>
                ) : (
                  <h1
                    className="text-2xl font-bold text-slate-900 cursor-pointer hover:text-blue-700 transition-colors"
                    onClick={() => { setTitleDraft(ticket.title); setEditingTitle(true) }}
                    title="Click to edit"
                  >
                    #{ticket.number} {ticket.title}
                  </h1>
                )}
                <p className="text-sm text-slate-500 mt-1">
                  Opened {new Date(ticket.createdAt).toLocaleString()} by{' '}
                  {ticket.reporter ? ticket.reporter.name : ticket.agentName ? `${ticket.agentName} (agent)` : 'Unknown'}
                </p>
              </div>

              {/* Description */}
              <div className="bg-white rounded-lg border border-slate-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-700">Description</h2>
                  {!editingDesc && (
                    <button
                      onClick={() => { setDescDraft(ticket.description ?? ''); setEditingDesc(true) }}
                      className="text-xs text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      Edit
                    </button>
                  )}
                </div>
                {editingDesc ? (
                  <div className="space-y-2">
                    <textarea
                      autoFocus
                      value={descDraft}
                      onChange={(e) => setDescDraft(e.target.value)}
                      rows={6}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y text-sm"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveDesc} disabled={saving}>Save</Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditingDesc(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : ticket.description ? (
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{ticket.description}</p>
                ) : (
                  <p className="text-sm text-slate-400 italic">No description provided.</p>
                )}
              </div>

              {/* Activity + Comments timeline */}
              <div className="bg-white rounded-lg border border-slate-200">
                <div className="px-5 py-3 border-b border-slate-100">
                  <h2 className="text-sm font-semibold text-slate-700">Activity</h2>
                </div>
                <div className="divide-y divide-slate-50">
                  {allEvents.length === 0 ? (
                    <p className="text-sm text-slate-400 px-5 py-4 italic">No activity yet.</p>
                  ) : (
                    allEvents.map((event) => {
                      if (event.type === 'comment') {
                        const c = event.data as TicketComment
                        return (
                          <div key={`c-${c.id}`} className={`px-5 py-4 ${c.internal ? 'bg-amber-50' : ''}`}>
                            <div className="flex items-center gap-2 mb-1.5 text-xs text-slate-500">
                              <AuthorLabel user={c.user} agentName={c.agentName} />
                              <span>commented</span>
                              {c.internal && (
                                <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">internal</span>
                              )}
                              <span>{new Date(c.createdAt).toLocaleString()}</span>
                            </div>
                            <p className="text-sm text-slate-800 whitespace-pre-wrap">{c.content}</p>
                          </div>
                        )
                      }

                      const a = event.data as TicketActivityEntry
                      if (a.action === 'created') return null // Skip — shown in title area
                      return (
                        <div key={`a-${a.id}`} className="px-5 py-2 flex items-center gap-1.5 text-xs text-slate-500">
                          <AuthorLabel user={a.user} agentName={a.agentName} />
                          <span>{ACTION_LABELS[a.action] ?? a.action}</span>
                          {a.fromValue && (
                            <span>
                              from <span className="font-medium text-slate-700">{a.fromValue}</span>
                            </span>
                          )}
                          {a.toValue && (
                            <span>
                              to <span className="font-medium text-slate-700">{a.toValue ?? 'unassigned'}</span>
                            </span>
                          )}
                          <span className="ml-auto">{new Date(a.createdAt).toLocaleString()}</span>
                        </div>
                      )
                    })
                  )}
                </div>

                {/* Comment box */}
                <div className="px-5 py-4 border-t border-slate-100">
                  <form onSubmit={submitComment} className="space-y-2">
                    <textarea
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="Leave a comment…"
                      rows={3}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                    />
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={commentInternal}
                          onChange={(e) => setCommentInternal(e.target.checked)}
                          className="rounded border-slate-300"
                        />
                        Internal note
                      </label>
                      <Button type="submit" size="sm" disabled={submittingComment || !commentText.trim()}>
                        {submittingComment ? 'Posting…' : 'Post Comment'}
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            </div>

            {/* Sidebar */}
            <div className="w-64 shrink-0 space-y-4">
              {/* Status */}
              <div className="bg-white rounded-lg border border-slate-200 p-4">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Details</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Status</label>
                    <select
                      value={ticket.status}
                      onChange={(e) => patch({ status: e.target.value })}
                      disabled={saving}
                      className={`w-full px-2 py-1.5 text-sm rounded-md border font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 ${STATUS_COLORS[ticket.status] ?? 'bg-white text-slate-700 border-slate-300'}`}
                    >
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Priority</label>
                    <select
                      value={ticket.priority}
                      onChange={(e) => patch({ priority: e.target.value })}
                      disabled={saving}
                      className={`w-full px-2 py-1.5 text-sm rounded-md border font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 ${PRIORITY_COLORS[ticket.priority] ?? 'bg-white text-slate-700'} border-slate-300`}
                    >
                      {PRIORITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Reporter</label>
                    <p className="text-sm text-slate-700">
                      {ticket.reporter?.name ?? ticket.agentName ?? 'Unknown'}
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Assignee</label>
                    <p className="text-sm text-slate-700">
                      {ticket.assignee?.name ?? <span className="text-slate-400 italic">Unassigned</span>}
                    </p>
                  </div>
                  {ticket.resolvedAt && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Resolved</label>
                      <p className="text-sm text-slate-700">{new Date(ticket.resolvedAt).toLocaleString()}</p>
                    </div>
                  )}
                  {ticket.closedAt && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Closed</label>
                      <p className="text-sm text-slate-700">{new Date(ticket.closedAt).toLocaleString()}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Quick actions */}
              <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-2">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Quick Actions</h3>
                {ticket.status !== 'in_progress' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    onClick={() => patch({ status: 'in_progress' })}
                    disabled={saving}
                  >
                    Mark In Progress
                  </Button>
                )}
                {ticket.status !== 'resolved' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    onClick={() => patch({ status: 'resolved' })}
                    disabled={saving}
                  >
                    Mark Resolved
                  </Button>
                )}
                {ticket.status !== 'closed' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    onClick={() => patch({ status: 'closed' })}
                    disabled={saving}
                  >
                    Close Ticket
                  </Button>
                )}
                {(ticket.status === 'resolved' || ticket.status === 'closed') && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    onClick={() => patch({ status: 'open' })}
                    disabled={saving}
                  >
                    Re-open
                  </Button>
                )}
              </div>

              {/* Danger zone */}
              <div className="bg-white rounded-lg border border-red-100 p-4">
                <h3 className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">Danger Zone</h3>
                {deleteConfirm ? (
                  <div className="space-y-2">
                    <p className="text-xs text-red-600">This cannot be undone.</p>
                    <Button variant="danger" size="sm" className="w-full" onClick={handleDelete}>
                      Confirm Delete
                    </Button>
                    <Button variant="secondary" size="sm" className="w-full" onClick={() => setDeleteConfirm(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button variant="danger" size="sm" className="w-full" onClick={() => setDeleteConfirm(true)}>
                    Delete Ticket
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  )
}
