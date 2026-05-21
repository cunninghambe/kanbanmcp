'use client'

import { useState } from 'react'
import { Avatar } from './Avatar'
import { Button } from '../ui/Button'

// ---------------------------------------------------------------------------
// Types (local — consumers pass these from their own interface)
// ---------------------------------------------------------------------------

export interface TimelineUser { id: string; name: string; email: string }

export interface TimelineComment {
  id: string
  content: string
  internal: boolean
  agentName: string | null
  createdAt: string
  user: TimelineUser | null
}

export interface TimelineActivity {
  id: string
  action: string
  fromValue: string | null
  toValue: string | null
  agentName: string | null
  createdAt: string
  user: TimelineUser | null
}

interface TicketTimelineProps {
  comments: TimelineComment[]
  activity: TimelineActivity[]
  onPostComment: (content: string, internal: boolean) => Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = {
  created: 'created this ticket',
  status_changed: 'changed status',
  priority_changed: 'changed priority',
  title_changed: 'changed title',
  assigned: 'changed assignee',
  commented: 'left a comment',
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the merged activity + comments timeline for a ticket detail page.
 * Handles the comment compose box. No data fetching — caller passes data + submit handler.
 */
export function TicketTimeline({ comments, activity, onPostComment }: TicketTimelineProps) {
  const [commentText, setCommentText] = useState('')
  const [commentInternal, setCommentInternal] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const allEvents = [
    ...comments.map((c) => ({ type: 'comment' as const, createdAt: c.createdAt, data: c })),
    ...activity.map((a) => ({ type: 'activity' as const, createdAt: a.createdAt, data: a })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!commentText.trim()) return
    setSubmitting(true)
    try {
      await onPostComment(commentText.trim(), commentInternal)
      setCommentText('')
      setCommentInternal(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
        <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>/// activity</span>
      </div>

      {allEvents.length === 0 ? (
        <p className="km-mono" style={{ padding: '16px', fontSize: 12, color: 'var(--fg-4)' }}>
          no activity yet.
        </p>
      ) : (
        <div>
          {allEvents.map((event) => {
            if (event.type === 'comment') {
              const c = event.data as TimelineComment
              return (
                <div
                  key={`c-${c.id}`}
                  style={{
                    padding: '12px 16px',
                    borderTop: '1px solid var(--line-faint)',
                    background: c.internal ? 'rgba(184,122,0,0.04)' : undefined,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Avatar
                      name={c.user?.name ?? c.agentName ?? '?'}
                      size="sm"
                      ai={!!c.agentName && !c.user}
                    />
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-0)', fontFamily: 'var(--font-body)' }}>
                      {c.user?.name ?? (c.agentName ? `${c.agentName} (agent)` : 'unknown')}
                    </span>
                    {c.internal && (
                      <span className="km-chip km-chip--warn">internal</span>
                    )}
                    <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginLeft: 'auto' }}>
                      {fmt(c.createdAt)}
                    </span>
                  </div>
                  <p style={{ fontSize: 13, color: 'var(--fg-1)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                    {c.content}
                  </p>
                </div>
              )
            }

            const a = event.data as TimelineActivity
            if (a.action === 'created') return null
            return (
              <div
                key={`a-${a.id}`}
                style={{
                  padding: '6px 16px',
                  borderTop: '1px solid var(--line-faint)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>
                  {a.user?.name ?? a.agentName ?? 'system'}
                </span>
                <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  {ACTION_LABELS[a.action] ?? a.action}
                  {a.fromValue && ` from ${a.fromValue}`}
                  {a.toValue && ` → ${a.toValue}`}
                </span>
                <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-4)', marginLeft: 'auto' }}>
                  {fmt(a.createdAt)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Comment compose box */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--line)', background: 'var(--bg-2)' }}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            className="km-input"
            value={commentText}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCommentText(e.target.value)}
            placeholder="Leave a comment…"
            rows={3}
            style={{ height: 'auto', resize: 'vertical', fontSize: 13 }}
            aria-label="New comment"
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={commentInternal}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCommentInternal(e.target.checked)}
                aria-label="Mark as internal note"
              />
              <span className="km-mono" style={{ fontSize: 10, letterSpacing: '0.06em' }}>internal note</span>
            </label>
            <Button type="submit" size="sm" disabled={submitting || !commentText.trim()}>
              {submitting ? 'posting…' : 'post comment'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
