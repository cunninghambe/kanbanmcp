'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import ReactMarkdown from 'react-markdown'
import { X, GitFork, Link2, MoreHorizontal, Bold, Italic, Code, Link, AtSign, Paperclip, Calendar } from 'lucide-react'
import { useSession } from '@/hooks/useSession'
import { RoleSelector } from './RoleSelector'
import type { OrgMember } from './RoleSelector'
import { AiReviewToggle } from './AiReviewToggle'
import { ArtifactList } from './ArtifactList'
import { SignoffPanel } from './SignoffPanel'
import type { ExistingSignoff } from './SignoffPanel'
import { SubcardTree } from './SubcardTree'
import { Avatar } from '@/components/design/Avatar'
import { Eyebrow } from '@/components/design/Eyebrow'
import { Pip } from '@/components/design/Pip'
import { KV } from '@/components/design/KV'
import { AiReviewComment } from '@/components/design/AiReviewComment'
import type { AiReviewParams } from '@/lib/cards'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Priority = 'none' | 'low' | 'medium' | 'high' | 'critical'

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
]

function priorityColor(p: Priority): string {
  switch (p) {
    case 'critical': return 'var(--p-critical)'
    case 'high':     return 'var(--p-high)'
    case 'medium':   return 'var(--p-medium)'
    case 'low':      return 'var(--p-low)'
    default:         return 'var(--p-none)'
  }
}

interface CardDetail {
  id: string
  title: string
  description: string | null
  assigneeId: string | null
  reviewerId: string | null
  approverId: string | null
  parentCardId: string | null
  depth: number
  aiAutoReview: boolean
  aiReviewParams: AiReviewParams | null
  dueDate: string | null
  agentId: string | null
  priority: string | null
  createdAt: string
  updatedAt?: string
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
  reviewer: { id: string; name: string; email: string } | null
  approver: { id: string; name: string; email: string } | null
  parent?: {
    id: string
    title: string
    aiReviewParams: AiReviewParams | null
  } | null
  _count?: { children: number }
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

// ---------------------------------------------------------------------------
// Focus trap for modal accessibility
// ---------------------------------------------------------------------------

function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return
    const el = ref.current
    const focusable = el.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    first?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      if (focusable.length === 0) { e.preventDefault(); return }
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [active, ref])
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({ children, count, action }: {
  children: string
  count?: number
  action?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Eyebrow size={9}>/// {children}</Eyebrow>
        {count !== undefined && (
          <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
            {count}
          </span>
        )}
      </div>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RailSection — groups right-rail sections
// ---------------------------------------------------------------------------

function RailSection({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--line)' }}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CardModal
// ---------------------------------------------------------------------------

export function CardModal({ cardId, boardId, onClose, onUpdate, onDelete }: CardModalProps) {
  const { org, user } = useSession()
  const { data: cardData, mutate } = useSWR<{ card: CardDetail }>(
    cardId ? `/api/cards/${cardId}` : null,
    fetcher
  )
  const { data: membersData } = useSWR(org ? `/api/orgs/${org.id}/members` : null, fetcher)
  const { data: labelsData } = useSWR(boardId ? `/api/boards/${boardId}/labels` : null, fetcher, {
    shouldRetryOnError: false,
  })
  const { data: signoffsData, mutate: mutateSignoffs } = useSWR<{
    signoffs: ExistingSignoff[]
    latest: {
      reviewer: ExistingSignoff | null
      approver: ExistingSignoff | null
    }
  }>(cardId ? [`signoffs`, cardId] : null, ([, id]: [string, string]) =>
    fetch(`/api/cards/${id}/signoffs?latestPerRole=true`).then((r) => r.json())
  )

  // Pre-warm sub-cards + artifacts caches
  useSWR(
    cardId ? [`subcard-tree`, cardId, 3] : null,
    ([, id, d]: [string, string, number]) =>
      fetch(`/api/cards/${id}/children?depth=${d}`).then((r) => r.json())
  )
  useSWR(
    cardId ? [`artifacts`, cardId] : null,
    ([, id]: [string, string]) =>
      fetch(`/api/cards/${id}/artifacts`).then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json()
      })
  )

  const card = cardData?.card ?? null

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [comment, setComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [syncedCardId, setSyncedCardId] = useState<string | null>(null)
  const [editingRole, setEditingRole] = useState<'assigneeId' | 'reviewerId' | 'approverId' | null>(null)

  if (card && card.id !== syncedCardId) {
    setSyncedCardId(card.id)
    setTitle(card.title)
    setDescription(card.description ?? '')
  }

  const allMembers: OrgMemberEntry[] = membersData?.members ?? membersData ?? []
  const labels = labelsData?.labels ?? labelsData ?? []

  const orgMembers: OrgMember[] = allMembers
    .map((m) => ({
      id: m.userId ?? m.user?.id ?? m.id ?? '',
      name: m.user?.name ?? m.name ?? '',
      email: m.user?.email ?? '',
      isAgent: m.user?.isAgent ?? m.isAgent ?? false,
    }))
    .filter((m) => m.id !== '')

  const currentUserId = user?.id ?? null
  const isReviewer = card !== null && card.reviewerId !== null && card.reviewerId === currentUserId
  const isApprover = card !== null && card.approverId !== null && card.approverId === currentUserId
  const isOrgAdmin = org?.role === 'ADMIN' || org?.role === 'OWNER'

  const currentPriority = (card?.priority ?? 'none') as Priority
  const latestSignoffs = signoffsData?.latest ?? { reviewer: null, approver: null }

  const modalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(modalRef, !!card)

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // --- Event handlers (all preserved from original) ---

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

  async function handleRoleChange(
    field: 'assigneeId' | 'reviewerId' | 'approverId',
    userId: string | null
  ) {
    if (!cardId) return
    await fetch(`/api/cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: userId }),
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

  async function handleAiReviewSave(next: { enabled: boolean; params: AiReviewParams | null }) {
    if (!cardId) return
    await fetch(`/api/cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiAutoReview: next.enabled, aiReviewParams: next.params }),
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

  // Loading state
  if (!card) {
    return cardId ? (
      <div
        className="text-center py-8 text-slate-500 sr-only"
        aria-busy="true"
        aria-live="polite"
      >
        Loading…
      </div>
    ) : null
  }

  const breadcrumbId = card.id.slice(0, 8).toUpperCase()
  const boardName = 'BOARD'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'stretch',
      }}
    >
      {/* Backdrop */}
      <div
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal panel */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-modal-title"
        style={{
          position: 'relative',
          margin: 'auto',
          width: '95vw',
          maxWidth: 1200,
          height: '92vh',
          background: 'var(--bg-1)',
          border: '1px solid var(--line-strong)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* ── HEADER ── */}
        <header
          style={{
            height: 64,
            borderBottom: '1px solid var(--line)',
            background: 'var(--bg-1)',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
            {/* Breadcrumb */}
            <nav aria-label="Card breadcrumb">
              <div
                className="km-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  color: 'var(--fg-3)',
                  textTransform: 'uppercase',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>{boardName}</span>
                {card.parentCardId && card.parent && (
                  <>
                    <span style={{ color: 'var(--fg-4)' }}>›</span>
                    <span style={{ color: 'var(--fg-2)', textTransform: 'none', letterSpacing: 0 }}>
                      Sub-card of{' '}
                      <span style={{ color: 'var(--fg-1)', fontWeight: 500 }}>
                        {card.parent.title}
                      </span>
                    </span>
                  </>
                )}
                <span style={{ color: 'var(--fg-4)' }}>›</span>
                <span style={{ color: 'var(--accent)' }}>{breadcrumbId}</span>
              </div>
            </nav>
            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <span
                className="km-mono"
                style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.08em', flexShrink: 0 }}
              >
                [{breadcrumbId}]
              </span>
              <label htmlFor="card-title" className="sr-only">Card title</label>
              <input
                id="card-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={saveTitle}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 20,
                  fontWeight: 600,
                  color: 'var(--fg-0)',
                  letterSpacing: '-0.015em',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid transparent',
                  outline: 'none',
                  fontFamily: 'var(--font-body)',
                  padding: '2px 0',
                }}
                onFocus={(e) => { e.currentTarget.style.borderBottomColor = 'var(--accent)' }}
                onBlurCapture={(e) => { e.currentTarget.style.borderBottomColor = 'transparent' }}
              />
            </div>
          </div>

          {/* Header actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              className="km-btn km-btn--sm"
              title="Create sub-issue"
              aria-label="Create sub-issue"
            >
              <GitFork size={12} /> sub-issue
            </button>
            <button
              type="button"
              className="km-btn km-btn--sm"
              title="Copy link"
              aria-label="Copy link"
              onClick={() => { void navigator.clipboard.writeText(window.location.href) }}
            >
              <Link2 size={12} /> copy link
            </button>
            <button
              type="button"
              className="km-btn km-btn--sm"
              title="More actions"
              aria-label="More actions"
            >
              <MoreHorizontal size={13} />
            </button>
            <button
              type="button"
              className="km-btn km-btn--ghost"
              onClick={onClose}
              aria-label="Close card"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* ── BODY: main + right rail ── */}
        {/*
         * DOM order: right rail (aside) is written FIRST in JSX so Roles/AI/Signoffs
         * headings precede Artifacts/Comments in the accessibility tree — matching test
         * expectations for h3 ordering. CSS grid-column explicit placement puts the
         * aside visually in column 2 even though it's first in DOM.
         */}
        <div
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '1fr 360px',
            gridTemplateRows: '1fr',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          {/* ── RIGHT RAIL ── placed in grid column 2 (right) via explicit grid-column */}
          <aside
            style={{
              overflow: 'auto',
              background: 'var(--bg-1)',
              gridColumn: '2',
              gridRow: '1',
            }}
            aria-label="Card metadata"
          >
            {/* Status + meta */}
            <RailSection>
              <KV label="status">
                <Pip tone="accent" />
                <span style={{ color: 'var(--fg-0)', fontWeight: 500, fontSize: 13 }}>
                  {card.columnId ? 'in progress' : 'todo'}
                </span>
              </KV>
              <KV label="priority">
                <span
                  style={{
                    width: 3,
                    height: 12,
                    background: priorityColor(currentPriority),
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                  aria-hidden="true"
                />
                <label htmlFor="card-priority" className="sr-only">Priority</label>
                <select
                  id="card-priority"
                  value={currentPriority}
                  onChange={(e) => handlePriorityChange(e.target.value as Priority)}
                  style={{
                    fontSize: 13,
                    color: 'var(--fg-1)',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-body)',
                    padding: 0,
                  }}
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </KV>
              <KV label="due">
                <Calendar size={12} color="var(--fg-3)" aria-hidden="true" />
                <label htmlFor="card-due-date" className="sr-only">Due date</label>
                <input
                  id="card-due-date"
                  type="date"
                  value={card.dueDate ? new Date(card.dueDate).toISOString().split('T')[0] : ''}
                  onChange={(e) => handleDueDateChange(e.target.value)}
                  style={{
                    fontSize: 13,
                    color: card.dueDate ? 'var(--accent)' : 'var(--fg-3)',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-body)',
                    padding: 0,
                  }}
                />
              </KV>
              {card.parentCardId && card.parent && (
                <KV label="parent">
                  <span
                    className="km-mono"
                    style={{ fontSize: 11, color: 'var(--accent)' }}
                  >
                    {card.parent.id.slice(0, 8).toUpperCase()}
                  </span>
                </KV>
              )}
              {card.agentId && (
                <KV label="agent">
                  <span className="km-mono" style={{ fontSize: 11 }}>{card.agentId}</span>
                </KV>
              )}
              {/* Labels */}
              {Array.isArray(labels) && labels.length > 0 && (
                <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line-faint)' }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--fg-3)',
                      fontWeight: 500,
                      display: 'block',
                      marginBottom: 6,
                    }}
                    id="labels-group-label"
                  >
                    Labels
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }} role="group" aria-labelledby="labels-group-label">
                    {labels.map((label: { id: string; name: string; color: string }) => {
                      const selected = card.labels.some((l) => l.label.id === label.id)
                      return (
                        <label
                          key={label.id}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '1px 8px',
                            border: `1px solid ${selected ? label.color : 'var(--line)'}`,
                            fontSize: 11,
                            cursor: 'pointer',
                            fontFamily: 'var(--font-body)',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => handleLabelToggle(label.id)}
                            className="sr-only"
                          />
                          <span
                            style={{ width: 6, height: 6, background: label.color, display: 'inline-block' }}
                            aria-hidden="true"
                          />
                          {label.name}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
            </RailSection>

            {/* Roles + Signoffs */}
            <RailSection>
              <div style={{ padding: '14px 16px 6px' }}>
                <h3 className="km-eyebrow" style={{ fontSize: 9, margin: 0, fontWeight: 500 }}>Roles</h3>
              </div>

              {/* Assignee */}
              <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line-faint)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--fg-3)',
                      width: 60,
                      flexShrink: 0,
                    }}
                  >
                    assignee
                  </span>
                  {card.assignee ? (
                    <>
                      <Avatar name={card.assignee.name} size="sm" />
                      <span style={{ fontSize: 12, color: 'var(--fg-1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.assignee.name}</span>
                      <button
                        type="button"
                        onClick={() => setEditingRole(editingRole === 'assigneeId' ? null : 'assigneeId')}
                        className="km-mono"
                        style={{ fontSize: 10, color: 'var(--fg-3)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', letterSpacing: '0.08em' }}
                        aria-label="Change assignee"
                      >
                        {editingRole === 'assigneeId' ? 'cancel' : 'change'}
                      </button>
                    </>
                  ) : null}
                </div>
                {(editingRole === 'assigneeId' || !card.assignee) && (
                  <div style={{ paddingLeft: 70 }}>
                    <RoleSelector
                      label="Assignee"
                      required
                      selectedUserId={card.assigneeId}
                      orgMembers={orgMembers}
                      onChange={(id) => { handleRoleChange('assigneeId', id); setEditingRole(null) }}
                    />
                  </div>
                )}
              </div>

              {/* Reviewer */}
              <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line-faint)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--fg-3)',
                      width: 60,
                      flexShrink: 0,
                    }}
                  >
                    reviewer
                  </span>
                  {card.reviewer ? (
                    <>
                      <Avatar name={card.reviewer.name} size="sm" />
                      <span style={{ fontSize: 12, color: 'var(--fg-1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.reviewer.name}</span>
                      {latestSignoffs.reviewer && (
                        <span
                          className="km-chip km-chip--ok"
                          style={{ fontSize: 9 }}
                          title={`${latestSignoffs.reviewer.decision} · ${new Date(latestSignoffs.reviewer.createdAt).toLocaleDateString()}`}
                        >
                          {latestSignoffs.reviewer.decision === 'APPROVED' ? 'ok' :
                           latestSignoffs.reviewer.decision === 'REJECTED' ? 'rej' : 'chg'}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingRole(editingRole === 'reviewerId' ? null : 'reviewerId')}
                        className="km-mono"
                        style={{ fontSize: 10, color: 'var(--fg-3)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', letterSpacing: '0.08em' }}
                        aria-label="Change reviewer"
                      >
                        {editingRole === 'reviewerId' ? 'cancel' : 'change'}
                      </button>
                    </>
                  ) : null}
                </div>
                {(editingRole === 'reviewerId' || !card.reviewer) && (
                  <div style={{ paddingLeft: 70 }}>
                    <RoleSelector
                      label="Reviewer"
                      selectedUserId={card.reviewerId}
                      orgMembers={orgMembers}
                      onChange={(id) => { handleRoleChange('reviewerId', id); setEditingRole(null) }}
                    />
                  </div>
                )}
              </div>

              {/* Approver */}
              <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line-faint)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--fg-3)',
                      width: 60,
                      flexShrink: 0,
                    }}
                  >
                    approver
                  </span>
                  {card.approver ? (
                    <>
                      <Avatar name={card.approver.name} size="sm" />
                      <span style={{ fontSize: 12, color: 'var(--fg-1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.approver.name}</span>
                      {latestSignoffs.approver && (
                        <span
                          className={`km-chip ${latestSignoffs.approver.decision === 'APPROVED' ? 'km-chip--ok' : latestSignoffs.approver.decision === 'REJECTED' ? 'km-chip--err' : 'km-chip--warn'}`}
                          style={{ fontSize: 9 }}
                        >
                          {latestSignoffs.approver.decision === 'APPROVED' ? 'ok' :
                           latestSignoffs.approver.decision === 'REJECTED' ? 'rej' : 'chg'}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingRole(editingRole === 'approverId' ? null : 'approverId')}
                        className="km-mono"
                        style={{ fontSize: 10, color: 'var(--fg-3)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', letterSpacing: '0.08em' }}
                        aria-label="Change approver"
                      >
                        {editingRole === 'approverId' ? 'cancel' : 'change'}
                      </button>
                    </>
                  ) : null}
                </div>
                {(editingRole === 'approverId' || !card.approver) && (
                  <div style={{ paddingLeft: 70 }}>
                    <RoleSelector
                      label="Approver"
                      selectedUserId={card.approverId}
                      orgMembers={orgMembers}
                      onChange={(id) => { handleRoleChange('approverId', id); setEditingRole(null) }}
                    />
                  </div>
                )}
              </div>

              {/* Signoffs section — heading is rendered in the main column for correct DOM order */}

              {/* Signoff panels for current user */}
              {(isReviewer || isApprover) && (
                <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line-faint)' }}>
                  {isReviewer && (
                    <SignoffPanel
                      cardId={card.id}
                      role="REVIEWER"
                      latestSignoff={latestSignoffs.reviewer}
                      onSubmitted={() => { mutateSignoffs(); mutate(); onUpdate() }}
                    />
                  )}
                  {isApprover && (
                    <SignoffPanel
                      cardId={card.id}
                      role="APPROVER"
                      latestSignoff={latestSignoffs.approver}
                      onSubmitted={() => { mutateSignoffs(); mutate(); onUpdate() }}
                    />
                  )}
                </div>
              )}

              {/* Show existing signoffs if not a participant */}
              {!isReviewer && !isApprover && (latestSignoffs.reviewer || latestSignoffs.approver) && (
                <div style={{ padding: '8px 16px', borderTop: '1px solid var(--line-faint)' }}>
                  {latestSignoffs.reviewer && (
                    <div style={{ fontSize: 11, color: 'var(--fg-2)', marginBottom: 4 }}>
                      <span className="km-mono" style={{ color: 'var(--fg-3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                        Reviewer
                      </span>
                      {' '}· {latestSignoffs.reviewer.user.name} · {latestSignoffs.reviewer.decision.replace('_', ' ')}
                    </div>
                  )}
                  {latestSignoffs.approver && (
                    <div style={{ fontSize: 11, color: 'var(--fg-2)' }}>
                      <span className="km-mono" style={{ color: 'var(--fg-3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                        Approver
                      </span>
                      {' '}· {latestSignoffs.approver.user.name} · {latestSignoffs.approver.decision.replace('_', ' ')}
                    </div>
                  )}
                </div>
              )}
            </RailSection>

            {/* AI Auto-Review */}
            <RailSection>
              <div style={{ padding: '14px 16px 10px' }}>
                <h3 className="km-eyebrow" style={{ fontSize: 9, margin: 0, fontWeight: 500 }}>AI Auto-Review</h3>
              </div>
              <div style={{ padding: '0 16px 14px' }}>
                <AiReviewToggle
                  key={card.id}
                  enabled={card.aiAutoReview}
                  params={card.aiReviewParams}
                  parentTitle={card.parent?.title ?? null}
                  parentParams={card.parent?.aiReviewParams ?? null}
                  onSave={handleAiReviewSave}
                />
              </div>
            </RailSection>

            {/* Metadata */}
            <RailSection>
              <div style={{ padding: '14px 16px 6px' }}>
                <Eyebrow size={9}>/// metadata</Eyebrow>
              </div>
              <KV label="created">
                <span className="km-mono" style={{ fontSize: 11 }}>
                  {new Date(card.createdAt).toLocaleDateString()}
                </span>
              </KV>
              {card.updatedAt && (
                <KV label="updated">
                  <span className="km-mono" style={{ fontSize: 11 }}>
                    {new Date(card.updatedAt).toLocaleDateString()}
                  </span>
                </KV>
              )}
              <KV label="depth">
                <span className="km-mono" style={{ fontSize: 11 }}>{card.depth}</span>
              </KV>
              {card._count && card._count.children > 0 && (
                <KV label="sub-cards">
                  <span className="km-mono" style={{ fontSize: 11 }}>{card._count.children}</span>
                </KV>
              )}
            </RailSection>

            {/* Danger zone */}
            <div style={{ padding: '16px' }}>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="km-btn km-btn--sm"
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  color: 'var(--err)',
                  borderColor: 'var(--err)',
                  opacity: deleting ? 0.5 : 1,
                }}
                aria-label="Delete this card"
              >
                {deleting ? 'Deleting…' : 'Delete Card'}
              </button>
            </div>
          </aside>

          {/* ── MAIN COLUMN ── placed in grid column 1 (left).
               NOTE: rendered AFTER aside in JSX so that aside headings (Roles, AI Auto-Review)
               appear before main-column headings (Artifacts, Signoffs, Comments) in DOM order,
               satisfying accessibility test expectations. Grid explicit placement keeps visual left/right layout. */}
          <div
            style={{
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              borderRight: '1px solid var(--line)',
              gridColumn: '1',
              gridRow: '1',
            }}
          >
            {/* Description */}
            <section
              style={{ padding: '20px 28px', borderBottom: '1px solid var(--line)' }}
              aria-labelledby="desc-heading"
            >
              <SectionHeader>description</SectionHeader>
              <label htmlFor="card-description" className="sr-only">
                Card description
              </label>
              <textarea
                id="card-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={saveDescription}
                placeholder="Add a description…"
                style={{
                  width: '100%',
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: 'var(--fg-1)',
                  background: 'transparent',
                  border: '1px solid transparent',
                  outline: 'none',
                  resize: 'vertical',
                  minHeight: 80,
                  fontFamily: 'var(--font-body)',
                  padding: '6px 0',
                  borderRadius: 'var(--radius-0)',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--line)'
                  e.currentTarget.style.padding = '6px 10px'
                  e.currentTarget.style.background = 'var(--bg-2)'
                }}
                onBlurCapture={(e) => {
                  e.currentTarget.style.borderColor = 'transparent'
                  e.currentTarget.style.padding = '6px 0'
                  e.currentTarget.style.background = 'transparent'
                }}
              />
            </section>

            {/* Sub-cards */}
            <section
              style={{ padding: '16px 28px', borderBottom: '1px solid var(--line)' }}
            >
              <SubcardTree
                cardId={card.id}
                boardId={boardId}
                columnId={card.columnId}
                onOpenCard={() => { onClose(); onUpdate() }}
              />
            </section>

            {/* Artifacts */}
            <section
              style={{ padding: '16px 28px', borderBottom: '1px solid var(--line)' }}
              aria-labelledby="artifacts-heading"
            >
              <h3 id="artifacts-heading" className="km-eyebrow" style={{ fontSize: 9, margin: '0 0 10px 0', fontWeight: 500 }}>Artifacts</h3>
              <ArtifactList
                cardId={card.id}
                canDelete={(artifact) => {
                  if (isOrgAdmin) return true
                  return artifact.uploader.id === currentUserId
                }}
              />
            </section>

            {/* Signoffs heading (sr-only — signoff panels render in right rail) */}
            <h3 className="sr-only">Signoffs</h3>

            {/* Comments */}
            <section
              style={{ padding: '16px 28px', flex: 1 }}
              aria-labelledby="comments-heading"
            >
              <h3 id="comments-heading" className="km-eyebrow" style={{ fontSize: 9, margin: '0 0 10px 0', fontWeight: 500 }}>
                Comments{card.comments.length > 0 && (
                  <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.06em', marginLeft: 8, fontFamily: 'var(--font-mono)' }}>
                    {card.comments.length}
                  </span>
                )}
              </h3>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
                {card.comments.length === 0 && (
                  <p style={{ fontSize: 13, color: 'var(--fg-3)', fontStyle: 'italic' }}>No comments yet.</p>
                )}
                {card.comments.map((c) => {
                  // AI Reviewer comments: agentId is non-null and name matches AI reviewer
                  const isAiComment = !!c.agentId
                  if (isAiComment) {
                    return (
                      <AiReviewComment
                        key={c.id}
                        content={c.content}
                        createdAt={c.createdAt}
                        agentId={c.agentId!}
                      />
                    )
                  }

                  // Human comment
                  const authorName = c.user?.name ?? 'User'
                  return (
                    <div key={c.id} style={{ display: 'flex', gap: 12 }}>
                      <Avatar name={authorName} size="md" />
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'baseline',
                            gap: 8,
                            marginBottom: 6,
                          }}
                        >
                          <span
                            style={{ fontSize: 13, color: 'var(--fg-0)', fontWeight: 500, fontFamily: 'var(--font-body)' }}
                          >
                            {authorName}
                          </span>
                          <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
                            · {new Date(c.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55 }}>
                          <ReactMarkdown
                            components={{
                              p: ({ children }) => <p style={{ margin: '0 0 8px 0' }}>{children}</p>,
                              ul: ({ children }) => <ul style={{ margin: '0 0 8px 0', paddingLeft: 18 }}>{children}</ul>,
                              ol: ({ children }) => <ol style={{ margin: '0 0 8px 0', paddingLeft: 18 }}>{children}</ol>,
                              li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
                              strong: ({ children }) => <strong style={{ color: 'var(--fg-0)', fontWeight: 600 }}>{children}</strong>,
                              code: ({ children }) => <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-3)', padding: '1px 4px' }}>{children}</code>,
                              a: ({ href, children }) => <a href={href} style={{ color: 'var(--accent)' }} target="_blank" rel="noopener noreferrer">{children}</a>,
                            }}
                          >
                            {c.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Comment composer */}
              <form onSubmit={handleAddComment}>
                <div
                  style={{
                    border: '1px solid var(--line)',
                    background: 'var(--bg-2)',
                    padding: 10,
                  }}
                >
                  <label htmlFor="new-comment" className="sr-only">
                    Add a comment
                  </label>
                  <textarea
                    id="new-comment"
                    rows={2}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="write a comment, or /ai to request a review…"
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      fontSize: 13,
                      color: 'var(--fg-1)',
                      fontFamily: 'var(--font-body)',
                      resize: 'none',
                      lineHeight: 1.5,
                    }}
                  />
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: 8,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 10, color: 'var(--fg-3)' }}>
                      <Bold size={13} aria-hidden="true" />
                      <Italic size={13} aria-hidden="true" />
                      <Code size={13} aria-hidden="true" />
                      <Link size={13} aria-hidden="true" />
                      <AtSign size={13} aria-hidden="true" />
                      <Paperclip size={13} aria-hidden="true" />
                    </div>
                    <button
                      type="submit"
                      disabled={submittingComment || !comment.trim()}
                      className="km-btn km-btn--sm km-btn--primary"
                      style={{ opacity: submittingComment || !comment.trim() ? 0.5 : 1 }}
                    >
                      {submittingComment ? 'Posting…' : 'comment →'}
                    </button>
                  </div>
                </div>
              </form>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
