'use client'

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ColumnWithCards, User } from '@/types'

type Priority = 'none' | 'low' | 'medium' | 'high' | 'critical'

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 'none',     label: 'None' },
  { value: 'low',      label: 'Low' },
  { value: 'medium',   label: 'Medium' },
  { value: 'high',     label: 'High' },
  { value: 'critical', label: 'Critical' },
]

interface MemberOption {
  id: string
  name: string
}

interface NewCardModalProps {
  boardId: string
  columns: ColumnWithCards[]
  members: MemberOption[]
  currentUser: User | null
  defaultColumnId?: string
  onClose: () => void
  onCreated: () => void
}

type SubmitError = { message: string }

/**
 * Modal form to create a new card on a board.
 * Accepts columns + members lists resolved by the parent.
 * POSTs to /api/boards/[boardId]/cards on submit.
 * On success: calls onCreated (which mutates the SWR cache) and closes.
 * On error: surfaces inline message, keeps modal open.
 * Does not fetch data; does not manage its own open/closed state.
 */
export function NewCardModal({
  boardId,
  columns,
  members,
  currentUser,
  defaultColumnId,
  onClose,
  onCreated,
}: NewCardModalProps) {
  const [title, setTitle] = useState('')
  const [columnId, setColumnId] = useState(
    defaultColumnId ?? columns[0]?.id ?? ''
  )
  const [assigneeId, setAssigneeId] = useState(currentUser?.id ?? '')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Priority>('none')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<SubmitError | null>(null)

  const titleRef = useRef<HTMLInputElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  // Focus title on open
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/boards/${boardId}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          columnId,
          assigneeId: assigneeId || null,
          description: description.trim() || null,
          priority,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError({ message: body.error ?? `Request failed: ${res.status}` })
        return
      }

      onCreated()
      onClose()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Unexpected error' })
    } finally {
      setSubmitting(false)
    }
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current) onClose()
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-card-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <div
        style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--line-strong)',
          width: 480,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 64px)',
          overflowY: 'auto',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span
            id="new-card-title"
            className="km-eyebrow"
            style={{ flex: 1, fontSize: 9 }}
          >
            new card
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="km-btn km-btn--ghost km-btn--sm"
            style={{ padding: 0, width: 26, height: 26, justifyContent: 'center' }}
          >
            <X size={13} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Title */}
          <div>
            <label
              htmlFor="nc-title"
              className="km-eyebrow"
              style={{ fontSize: 9, display: 'block', marginBottom: 6 }}
            >
              title *
            </label>
            <input
              ref={titleRef}
              id="nc-title"
              type="text"
              required
              className="km-input"
              placeholder="Card title…"
              value={title}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
            />
          </div>

          {/* Column + Priority row */}
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label
                htmlFor="nc-column"
                className="km-eyebrow"
                style={{ fontSize: 9, display: 'block', marginBottom: 6 }}
              >
                column
              </label>
              <select
                id="nc-column"
                className="km-input"
                value={columnId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setColumnId(e.target.value)}
                style={{ appearance: 'none', cursor: 'pointer' }}
              >
                {columns.map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.name.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label
                htmlFor="nc-priority"
                className="km-eyebrow"
                style={{ fontSize: 9, display: 'block', marginBottom: 6 }}
              >
                priority
              </label>
              <select
                id="nc-priority"
                className="km-input"
                value={priority}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPriority(e.target.value as Priority)}
                style={{ appearance: 'none', cursor: 'pointer' }}
              >
                {PRIORITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Assignee */}
          <div>
            <label
              htmlFor="nc-assignee"
              className="km-eyebrow"
              style={{ fontSize: 9, display: 'block', marginBottom: 6 }}
            >
              assignee
            </label>
            <select
              id="nc-assignee"
              className="km-input"
              value={assigneeId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAssigneeId(e.target.value)}
              style={{ appearance: 'none', cursor: 'pointer' }}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === currentUser?.id ? `${m.name} (me)` : m.name}
                </option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor="nc-description"
              className="km-eyebrow"
              style={{ fontSize: 9, display: 'block', marginBottom: 6 }}
            >
              description
            </label>
            <textarea
              id="nc-description"
              className="km-input"
              rows={3}
              placeholder="Optional description…"
              value={description}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
              style={{ height: 'auto', resize: 'vertical' }}
            />
          </div>

          {/* Error */}
          {error && (
            <div
              className="km-mono"
              style={{ fontSize: 11, color: 'var(--err)', padding: '8px 10px', border: '1px solid var(--err)', background: 'var(--accent-tint)' }}
              role="alert"
            >
              {error.message}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
            <button
              type="button"
              className="km-btn km-btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              cancel
            </button>
            <button
              type="submit"
              className="km-btn km-btn--primary"
              disabled={submitting || !title.trim()}
              style={{ opacity: submitting || !title.trim() ? 0.5 : 1 }}
            >
              {submitting ? 'creating…' : 'create card'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
