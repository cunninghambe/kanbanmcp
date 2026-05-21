'use client'

import React, { useState, useEffect, useRef } from 'react'
import { ChevronRight, MoreHorizontal, ArrowUpToLine } from 'lucide-react'
import type { SubtreeNode } from '@/lib/tree'

export interface SubcardRowProps {
  node: SubtreeNode
  hasChildren: boolean
  isExpanded: boolean
  isLoading: boolean
  onToggleExpand: () => void
  onPromote: () => Promise<void>
  onOpen: (cardId: string) => void
  depth: number
}

const SIGNOFF_DECISION_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  REQUESTED_CHANGES: 'Changes',
}

// Status to chip color mapping using design tokens
function getStatusStyle(status: string | null): React.CSSProperties {
  switch (status) {
    case 'done':
      return { color: 'var(--ok)', borderColor: 'var(--ok)' }
    case 'review':
      return { color: 'var(--warn)', borderColor: 'var(--warn)' }
    case 'doing':
    case 'in_progress':
    case 'IN_PROGRESS':
      return { color: 'var(--accent)', borderColor: 'var(--accent)' }
    default:
      return { color: 'var(--fg-3)', borderColor: 'var(--line)' }
  }
}

function statusLabel(columnId: string | null | undefined, status: string | null): string {
  // We don't have a column status field directly — use a short label from the node's column context
  // The node has no explicit status field, so we approximate from signoffs
  void columnId
  void status
  return 'todo'
}

// ---- PromoteConfirmDialog ---------------------------------------------------

interface PromoteConfirmDialogProps {
  cardTitle: string
  onConfirm: () => void
  onCancel: () => void
}

function PromoteConfirmDialog({ cardTitle, onConfirm, onCancel }: PromoteConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} aria-hidden="true" />
      <dialog
        open
        aria-modal="true"
        aria-labelledby="promote-dialog-title"
        style={{
          position: 'relative',
          background: 'var(--bg-2)',
          border: '1px solid var(--line-strong)',
          borderRadius: 'var(--radius-0)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
          width: '100%',
          maxWidth: 380,
          padding: 24,
          margin: 0,
        }}
      >
        <h2
          id="promote-dialog-title"
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--fg-0)',
            marginBottom: 8,
            fontFamily: 'var(--font-body)',
          }}
        >
          Promote to top-level card?
        </h2>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 20, lineHeight: 1.5 }}>
          &ldquo;{cardTitle}&rdquo; will be moved out of its parent and become a top-level card.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="km-btn km-btn--sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="km-btn km-btn--sm km-btn--primary"
          >
            Promote
          </button>
        </div>
      </dialog>
    </div>
  )
}

// ---- SubcardRow -------------------------------------------------------------

export function SubcardRow({
  node,
  hasChildren,
  isExpanded,
  isLoading,
  onToggleExpand,
  onPromote,
  onOpen,
  depth,
}: SubcardRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [showPromoteDialog, setShowPromoteDialog] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const [promoteError, setPromoteError] = useState<string | null>(null)
  const menuContainerRef = useRef<HTMLDivElement>(null)

  const childrenListId = `children-${node.id}`

  // Derive a simple status string from the node (signoffs give us some signal)
  const hasDoneSignoff =
    node.signoffs.reviewer?.decision === 'APPROVED' &&
    node.signoffs.approver?.decision === 'APPROVED'
  const hasReviewSignoff =
    node.signoffs.reviewer?.decision === 'APPROVED' && !node.signoffs.approver
  const nodeStatus = hasDoneSignoff ? 'done' : hasReviewSignoff ? 'review' : null
  const chipStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    padding: '1px 6px',
    border: '1px solid',
    minWidth: 38,
    textAlign: 'center',
    flexShrink: 0,
    ...getStatusStyle(nodeStatus),
  }
  const chipLabel = nodeStatus === 'done' ? 'done' : nodeStatus === 'review' ? 'rev' : 'todo'

  useEffect(() => {
    if (!menuOpen) return
    function handleMouseDown(e: MouseEvent) {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [menuOpen])

  async function handlePromoteConfirmed() {
    setShowPromoteDialog(false)
    setPromoting(true)
    setPromoteError(null)
    setMenuOpen(false)
    try {
      await onPromote()
    } catch {
      setPromoteError('Promote failed. Please try again.')
    } finally {
      setPromoting(false)
    }
  }

  function handleMenuKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Escape') setMenuOpen(false)
  }

  // Build the indent guide column spans
  const guides = Array.from({ length: depth })

  return (
    <>
      {showPromoteDialog && (
        <PromoteConfirmDialog
          cardTitle={node.title}
          onConfirm={() => void handlePromoteConfirmed()}
          onCancel={() => setShowPromoteDialog(false)}
        />
      )}
      <li style={{ listStyle: 'none' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            borderTop: depth === 0 ? '1px solid var(--line-faint)' : 0,
          }}
        >
          {/* Indent guide columns */}
          {guides.map((_, i) => (
            <div
              key={i}
              style={{
                width: 20,
                borderRight: '1px solid var(--line-faint)',
                flexShrink: 0,
              }}
              aria-hidden="true"
            />
          ))}

          {/* Row content */}
          <div
            style={{
              flex: 1,
              padding: '8px 12px 8px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderTop: depth > 0 ? '1px solid var(--line-faint)' : 0,
              background: 'var(--bg-2)',
            }}
          >
            {/* Tree elbow glyph */}
            {depth > 0 && (
              <span
                className="km-mono"
                style={{ color: 'var(--fg-4)', fontSize: 12, marginLeft: -2, flexShrink: 0 }}
                aria-hidden="true"
              >
                └
              </span>
            )}

            {/* Expand/collapse chevron */}
            {hasChildren ? (
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-controls={childrenListId}
                aria-label={
                  isExpanded
                    ? `Collapse sub-cards of ${node.title}`
                    : `Expand sub-cards of ${node.title}`
                }
                onClick={onToggleExpand}
                disabled={isLoading}
                style={{
                  flexShrink: 0,
                  width: 16,
                  height: 16,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--fg-3)',
                  background: 'none',
                  border: 'none',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  opacity: isLoading ? 0.5 : 1,
                  padding: 0,
                }}
              >
                <ChevronRight
                  size={12}
                  style={{
                    transform: isExpanded ? 'rotate(90deg)' : undefined,
                    transition: 'transform 120ms ease',
                  }}
                />
              </button>
            ) : (
              <span style={{ flexShrink: 0, width: 16 }} aria-hidden="true" />
            )}

            {/* Mono card ID */}
            <span
              className="km-mono"
              style={{
                fontSize: 10,
                color: 'var(--fg-3)',
                letterSpacing: '0.06em',
                minWidth: 56,
                flexShrink: 0,
              }}
            >
              {node.id.slice(0, 8).toUpperCase()}
            </span>

            {/* Status chip */}
            <span style={chipStyle}>{chipLabel}</span>

            {/* Title button */}
            <button
              type="button"
              onClick={() => onOpen(node.id)}
              style={{
                flex: 1,
                textAlign: 'left',
                fontSize: 13,
                color: 'var(--fg-1)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                padding: 0,
                letterSpacing: '-0.005em',
                fontFamily: 'var(--font-body)',
              }}
              title={node.title}
            >
              {node.title}
            </button>

            {/* AI indicator */}
            {node.aiAutoReview && (
              <span
                className="km-mono"
                style={{
                  fontSize: 9,
                  letterSpacing: '0.1em',
                  color: 'var(--accent)',
                  padding: '0 4px',
                  border: '1px solid var(--accent)',
                  flexShrink: 0,
                }}
                title="AI auto-review enabled"
              >
                AI
              </span>
            )}

            {/* Assignee avatar */}
            {node.assignee && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  background: 'var(--fg-1)',
                  color: 'var(--bg-0)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 8,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  borderRadius: 'var(--radius-pill)',
                  flexShrink: 0,
                }}
                title={node.assignee.name}
                aria-hidden="true"
              >
                {node.assignee.name.charAt(0).toUpperCase()}
              </span>
            )}

            {/* Signoff badges */}
            {node.signoffs.reviewer && (
              <span
                className="km-mono"
                style={{
                  fontSize: 8,
                  padding: '1px 4px',
                  border: '1px solid',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  flexShrink: 0,
                  color:
                    node.signoffs.reviewer.decision === 'APPROVED'
                      ? 'var(--ok)'
                      : node.signoffs.reviewer.decision === 'REJECTED'
                      ? 'var(--err)'
                      : 'var(--warn)',
                  borderColor:
                    node.signoffs.reviewer.decision === 'APPROVED'
                      ? 'var(--ok)'
                      : node.signoffs.reviewer.decision === 'REJECTED'
                      ? 'var(--err)'
                      : 'var(--warn)',
                }}
                title={`Reviewer: ${SIGNOFF_DECISION_LABEL[node.signoffs.reviewer.decision] ?? node.signoffs.reviewer.decision}`}
              >
                R
              </span>
            )}
            {node.signoffs.approver && (
              <span
                className="km-mono"
                style={{
                  fontSize: 8,
                  padding: '1px 4px',
                  border: '1px solid',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  flexShrink: 0,
                  color:
                    node.signoffs.approver.decision === 'APPROVED'
                      ? 'var(--ok)'
                      : node.signoffs.approver.decision === 'REJECTED'
                      ? 'var(--err)'
                      : 'var(--warn)',
                  borderColor:
                    node.signoffs.approver.decision === 'APPROVED'
                      ? 'var(--ok)'
                      : node.signoffs.approver.decision === 'REJECTED'
                      ? 'var(--err)'
                      : 'var(--warn)',
                }}
                title={`Approver: ${SIGNOFF_DECISION_LABEL[node.signoffs.approver.decision] ?? node.signoffs.approver.decision}`}
              >
                A
              </span>
            )}

            {/* Action menu */}
            <div ref={menuContainerRef} style={{ position: 'relative', flexShrink: 0 }}>
              <button
                type="button"
                aria-label={`Actions for ${node.title}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
                onKeyDown={handleMenuKeyDown}
                style={{
                  width: 24,
                  height: 24,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--fg-3)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
                className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <MoreHorizontal size={14} />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 28,
                    zIndex: 10,
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line-strong)',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                    minWidth: 180,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={promoting}
                    onClick={() => {
                      setMenuOpen(false)
                      setShowPromoteDialog(true)
                    }}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 12px',
                      fontSize: 13,
                      color: 'var(--fg-1)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontFamily: 'var(--font-body)',
                    }}
                  >
                    <ArrowUpToLine size={13} />
                    {promoting ? 'Promoting…' : 'Promote to top-level'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {promoteError && (
          <p
            style={{ fontSize: 12, color: 'var(--err)', marginTop: 2, paddingLeft: depth * 20 + 8 }}
            role="alert"
          >
            {promoteError}
          </p>
        )}
      </li>
    </>
  )
}
