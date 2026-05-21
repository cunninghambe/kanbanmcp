'use client'

import React, { useId, useState } from 'react'
import { z } from 'zod'

export type SignoffRole = 'REVIEWER' | 'APPROVER'
export type SignoffDecision = 'APPROVED' | 'REJECTED' | 'REQUESTED_CHANGES'

export type ExistingSignoff = {
  id: string
  role: SignoffRole
  decision: SignoffDecision
  comment: string | null
  createdAt: string
  user: { id: string; name: string; email: string }
}

const submitSchema = z.object({
  comment: z.string().max(2000, 'Comment must be 2000 chars or fewer').optional(),
})

type DecisionMeta = { label: string; ariaLabel: string; bg: string; fg: string }
const DECISION_CONFIG: Record<SignoffDecision, DecisionMeta> = {
  APPROVED: {
    label: 'Approve',
    ariaLabel: 'Approve this card',
    bg: 'var(--ok)',
    fg: 'var(--fg-inverse)',
  },
  REQUESTED_CHANGES: {
    label: 'Request changes',
    ariaLabel: 'Request changes to this card',
    bg: 'var(--warn)',
    fg: 'var(--fg-inverse)',
  },
  REJECTED: {
    label: 'Reject',
    ariaLabel: 'Reject this card',
    bg: 'var(--err)',
    fg: 'var(--fg-inverse)',
  },
}

const DECISION_TONE: Record<SignoffDecision, { color: string }> = {
  APPROVED: { color: 'var(--ok)' },
  REJECTED: { color: 'var(--err)' },
  REQUESTED_CHANGES: { color: 'var(--warn)' },
}

const DECISION_LABEL: Record<SignoffDecision, string> = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  REQUESTED_CHANGES: 'Changes requested',
}

interface SignoffPanelProps {
  cardId: string
  role: SignoffRole
  latestSignoff?: ExistingSignoff | null
  onSubmitted: () => void
}

export function SignoffPanel({ cardId, role, latestSignoff, onSubmitted }: SignoffPanelProps) {
  const commentId = useId()
  const [comment, setComment] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const roleLabel = role === 'REVIEWER' ? 'Reviewer' : 'Approver'

  async function handleDecision(decision: SignoffDecision) {
    setSubmitError(null)
    setCommentError(null)
    setSuccessMessage(null)

    const validation = submitSchema.safeParse({ comment: comment || undefined })
    if (!validation.success) {
      setCommentError(validation.error.issues[0]?.message ?? 'Invalid comment')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/cards/${cardId}/signoffs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, decision, comment: comment.trim() || undefined }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setSubmitError(body.error ?? 'Submission failed. Please try again.')
        return
      }
      setComment('')
      setSuccessMessage(`${DECISION_LABEL[decision]} successfully recorded.`)
      onSubmitted()
    } catch {
      setSubmitError('Submission failed. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        background: 'var(--bg-1)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {latestSignoff && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            className="km-eyebrow"
            style={{ fontSize: 9, color: 'var(--fg-3)' }}
          >
            Latest {roleLabel} decision
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span
              className="km-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                padding: '2px 6px',
                border: `1px solid ${DECISION_TONE[latestSignoff.decision].color}`,
                color: DECISION_TONE[latestSignoff.decision].color,
              }}
            >
              {DECISION_LABEL[latestSignoff.decision]}
            </span>
            <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
              by {latestSignoff.user.name} · {new Date(latestSignoff.createdAt).toLocaleString()}
            </span>
          </div>
          {latestSignoff.comment && (
            <p
              style={{
                marginTop: 4,
                padding: '6px 8px',
                fontSize: 12,
                color: 'var(--fg-1)',
                background: 'var(--bg-2)',
                border: '1px solid var(--line-faint)',
                lineHeight: 1.45,
              }}
            >
              {latestSignoff.comment}
            </p>
          )}
        </div>
      )}

      <fieldset disabled={submitting} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <legend
          className="km-eyebrow"
          style={{ fontSize: 9, color: 'var(--fg-3)' }}
        >
          Record {roleLabel} decision
        </legend>

        <div>
          <label
            htmlFor={commentId}
            className="km-eyebrow"
            style={{ fontSize: 9, color: 'var(--fg-3)', display: 'block', marginBottom: 4 }}
          >
            Comment <span style={{ color: 'var(--fg-4)', textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
          </label>
          <textarea
            id={commentId}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value)
              if (commentError) setCommentError(null)
            }}
            maxLength={2000}
            rows={2}
            placeholder="Add a comment…"
            aria-invalid={!!commentError}
            aria-describedby={commentError ? `${commentId}-error` : undefined}
            className="km-input"
            style={{ resize: 'none', height: 'auto', minHeight: 48, padding: '6px 10px', fontSize: 13 }}
          />
          {commentError && (
            <p id={`${commentId}-error`} style={{ fontSize: 11, color: 'var(--err)', marginTop: 2 }} role="alert">
              {commentError}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['APPROVED', 'REQUESTED_CHANGES', 'REJECTED'] as const).map((decision) => {
            const cfg = DECISION_CONFIG[decision]
            return (
              <button
                key={decision}
                type="button"
                onClick={() => handleDecision(decision)}
                disabled={submitting}
                aria-label={cfg.ariaLabel}
                className="km-btn km-btn--sm"
                style={{
                  background: cfg.bg,
                  color: cfg.fg,
                  border: `1px solid ${cfg.bg}`,
                  opacity: submitting ? 0.5 : 1,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                }}
              >
                {submitting ? 'Submitting…' : cfg.label}
              </button>
            )
          })}
        </div>
      </fieldset>

      {submitError && (
        <p style={{ fontSize: 11, color: 'var(--err)' }} role="alert" aria-live="assertive">
          {submitError}
        </p>
      )}
      {successMessage && (
        <p style={{ fontSize: 11, color: 'var(--ok)' }} role="status" aria-live="polite">
          {successMessage}
        </p>
      )}
    </div>
  )
}
