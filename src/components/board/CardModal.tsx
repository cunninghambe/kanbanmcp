'use client'

import { useState, useEffect } from 'react'
import useSWR from 'swr'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useSession } from '@/hooks/useSession'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Priority = 'none' | 'low' | 'medium' | 'high' | 'critical'

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
]

function getPrioritySelectClass(priority: Priority): string {
  switch (priority) {
    case 'critical':
      return 'bg-red-500 text-white'
    case 'high':
      return 'bg-orange-500 text-white'
    case 'medium':
      return 'bg-yellow-400 text-gray-900'
    case 'low':
      return 'bg-blue-400 text-white'
    case 'none':
    default:
      return 'bg-gray-100 text-gray-700'
  }
}

// The shape returned by GET /api/cards/[cardId]
interface CardDetail {
  id: string
  title: string
  description: string | null
  assigneeId: string | null
  dueDate: string | null
  agentId: string | null
  priority: string | null
  createdAt: string
  columnId: string
  sprintId: string | null
  labels: { label: { id: string; name: string; color: string } }[]
  comments: {
    id: string
    content: string
    createdAt: string
    agentId: string | null
    userId: string | null
    user?: { id: string; name: string; email: string } | null
  }[]
  assignee: { id: string; name: string; email: string } | null
}

interface OrgMemberEntry {
  userId?: string
  user?: { id: string; name: string; email: string; isAgent?: boolean }
  id?: string
  name?: string
  isAgent?: boolean
}

interface CardModalProps {
  cardId: string | null
  boardId: string
  onClose: () => void
  onUpdate: () => void
  onDelete: () => void
}

export function CardModal({ cardId, boardId, onClose, onUpdate, onDelete }: CardModalProps) {
  const { org } = useSession()
  const { data: cardData, mutate } = useSWR<{ card: CardDetail }>(
    cardId ? `/api/cards/${cardId}` : null,
    fetcher
  )
  const { data: membersData } = useSWR(
    org ? `/api/orgs/${org.id}/members` : null,
    fetcher
  )
  const { data: labelsData } = useSWR(
    boardId ? `/api/boards/${boardId}/labels` : null,
    fetcher,
    { shouldRetryOnError: false }
  )

  const card = cardData?.card ?? null

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [comment, setComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (card) {
      setTitle(card.title)
      setDescription(card.description ?? '')
    }
  }, [card])

  const allMembers: OrgMemberEntry[] = membersData?.members ?? membersData ?? []
  const labels = labelsData?.labels ?? labelsData ?? []

  // Separate human members from agent members for grouped display
  const humanMembers = allMembers.filter((m) => !m.user?.isAgent && !m.isAgent)
  const agentMembers = allMembers.filter((m) => m.user?.isAgent || m.isAgent)

  async function saveTitle() {
    if (!cardId || !card || title === card.title) return
    await fetch(`/api/cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    mutate()
    onUpdate()
  }

  async function saveDescription() {
    if (!cardId || !card || description === (card.description ?? '')) return
    await fetch(`/api/cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    })
    mutate()
    onUpdate()
  }

  async function handleAssigneeChange(assigneeId: string) {
    if (!cardId) return
    await fetch(`/api/cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigneeId: assigneeId || null }),
    })
    mutate()
    onUpdate()
  }

  async function handleDueDateChange(dueDate: string) {
    if (!cardId) return
    await fetch(`/api/cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dueDate: dueDate ? new Date(dueDate).toISOString() : null }),
    })
    mutate()
    onUpdate()
  }

  async function handlePriorityChange(priority: Priority) {
    if (!cardId) return
    try {
      const res = await fetch(`/api/cards/${cardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      })
      if (!res.ok) {
        console.error('[CardModal] priority update failed:', res.status)
        return
      }
      mutate()
      onUpdate()
    } catch (err) {
      console.error('[CardModal] priority update error:', err)
    }
  }

  async function handleLabelToggle(labelId: string) {
    if (!cardId || !card) return
    const currentLabels = card.labels.map((l) => l.label.id)
    const newLabels = currentLabels.includes(labelId)
      ? currentLabels.filter((id) => id !== labelId)
      : [...currentLabels, labelId]
    await fetch(`/api/cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: newLabels }),
    })
    mutate()
    onUpdate()
  }

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault()
    if (!cardId || !comment.trim()) return
    setSubmittingComment(true)
    try {
      await fetch(`/api/cards/${cardId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: comment.trim() }),
      })
      setComment('')
      mutate()
    } finally {
      setSubmittingComment(false)
    }
  }

  async function handleDelete() {
    if (!cardId || !confirm('Delete this card?')) return
    setDeleting(true)
    try {
      await fetch(`/api/cards/${cardId}`, { method: 'DELETE' })
      onDelete()
      onClose()
    } finally {
      setDeleting(false)
    }
  }

  const currentPriority = (card?.priority ?? 'none') as Priority

  return (
    <Modal open={!!cardId} onClose={onClose} size="xl" title="Card Details">
      {!card ? (
        <div className="text-center py-8 text-slate-500">Loading…</div>
      ) : (
        <div className="space-y-6">
          {/* Title */}
          <div>
            <input
              className="w-full text-xl font-semibold text-slate-900 border-0 border-b-2 border-transparent hover:border-slate-200 focus:border-blue-500 focus:outline-none px-0 py-1 transition-colors"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
            />
          </div>

          <div className="grid grid-cols-3 gap-6">
            {/* Main content */}
            <div className="col-span-2 space-y-4">
              {/* Description */}
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 block">
                  Description
                </label>
                <textarea
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[100px] resize-y"
                  placeholder="Add a description…"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={saveDescription}
                />
              </div>

              {/* Comments */}
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">
                  Comments
                </label>
                <div className="space-y-3 mb-3">
                  {card.comments.length === 0 && (
                    <p className="text-sm text-slate-400 italic">No comments yet</p>
                  )}
                  {card.comments.map((c) => {
                    const authorName = c.agentId
                      ? `Agent: ${c.agentId}`
                      : c.user?.name ?? 'User'
                    const avatarContent = c.agentId ? 'A' : (c.user?.name?.charAt(0).toUpperCase() ?? '?')
                    return (
                      <div key={c.id} className="flex gap-3">
                        <div className="w-7 h-7 rounded-full bg-slate-300 flex items-center justify-center text-slate-600 text-xs font-bold flex-shrink-0">
                          {avatarContent}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-xs font-medium text-slate-700">
                              {authorName}
                            </span>
                            <span className="text-xs text-slate-400">
                              {new Date(c.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-sm text-slate-600 bg-slate-50 rounded-md px-3 py-2">
                            {c.content}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <form onSubmit={handleAddComment} className="flex gap-2">
                  <textarea
                    className="flex-1 px-3 py-2 border border-slate-200 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                    placeholder="Add a comment…"
                    rows={2}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                  <Button type="submit" disabled={submittingComment || !comment.trim()} size="sm">
                    Post
                  </Button>
                </form>
              </div>
            </div>

            {/* Sidebar metadata */}
            <div className="space-y-4">
              {/* Priority */}
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 block">
                  Priority
                </label>
                <select
                  className={`w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 ${getPrioritySelectClass(currentPriority)}`}
                  value={currentPriority}
                  onChange={(e) => handlePriorityChange(e.target.value as Priority)}
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Assignee */}
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 block">
                  Assignee
                </label>
                <select
                  className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={card.assigneeId ?? ''}
                  onChange={(e) => handleAssigneeChange(e.target.value)}
                >
                  <option value="">Unassigned</option>

                  {/* Human members */}
                  {humanMembers.length > 0 && (
                    <optgroup label="Team Members">
                      {humanMembers.map((m) => {
                        const id = m.userId ?? m.id ?? ''
                        const name = m.user?.name ?? m.name ?? ''
                        return (
                          <option key={id} value={id}>{name}</option>
                        )
                      })}
                    </optgroup>
                  )}

                  {/* Agent members */}
                  {agentMembers.length > 0 && (
                    <optgroup label="Agents">
                      {agentMembers.map((m) => {
                        const id = m.userId ?? m.id ?? ''
                        const name = m.user?.name ?? m.name ?? ''
                        return (
                          <option key={id} value={id}>🤖 {name}</option>
                        )
                      })}
                    </optgroup>
                  )}
                </select>
              </div>

              {/* Due date */}
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 block">
                  Due Date
                </label>
                <input
                  type="date"
                  className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={card.dueDate ? new Date(card.dueDate).toISOString().split('T')[0] : ''}
                  onChange={(e) => handleDueDateChange(e.target.value)}
                />
              </div>

              {/* Labels */}
              {Array.isArray(labels) && labels.length > 0 && (
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 block">
                    Labels
                  </label>
                  <div className="space-y-1">
                    {labels.map((label: { id: string; name: string; color: string }) => {
                      const selected = card.labels.some((l) => l.label.id === label.id)
                      return (
                        <label key={label.id} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => handleLabelToggle(label.id)}
                            className="rounded"
                          />
                          <span
                            className="w-3 h-3 rounded-full inline-block"
                            style={{ backgroundColor: label.color }}
                          />
                          <span className="text-sm text-slate-700">{label.name}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div className="pt-2 border-t border-slate-100 text-xs text-slate-400 space-y-1">
                {card.agentId && (
                  <div className="flex items-center gap-1">
                    <Badge>Agent: {card.agentId}</Badge>
                  </div>
                )}
                <p>Created {new Date(card.createdAt).toLocaleDateString()}</p>
              </div>

              {/* Delete */}
              <Button
                variant="danger"
                size="sm"
                className="w-full"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete Card'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
