'use client'

import { Draggable } from '@hello-pangea/dnd'
import { getPriorityClass } from '@/components/design/PriorityBar'
import type { Card, Label, User } from '@/types'

interface KanbanCardProps {
  card: Card & {
    labels?: { label: Label }[]
    assignee?: User | null
    priority?: string
  }
  index: number
  onClick: () => void
  onHover?: () => void
}

function getRelativeDate(date: Date | string | null): { text: string; overdue: boolean } | null {
  if (!date) return null
  const d = new Date(date)
  const now = new Date()
  const diffMs = d.getTime() - now.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  const overdue = diffDays < 0
  if (diffDays === 0) return { text: 'due today', overdue }
  if (diffDays === -1) return { text: 'yesterday', overdue: true }
  if (diffDays === 1) return { text: 'tomorrow', overdue: false }
  if (diffDays < 0) return { text: `${Math.abs(diffDays)}d overdue`, overdue: true }
  return { text: `due in ${diffDays}d`, overdue: false }
}

/** Derive a short display ID from a cuid-style card id */
function displayId(id: string): string {
  return `[${id.slice(0, 8).toUpperCase()}]`
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function KanbanCard({ card, index, onClick, onHover }: KanbanCardProps) {
  const dueInfo = getRelativeDate(card.dueDate ?? null)
  const priority = card.priority ?? 'none'
  const priorityCls = getPriorityClass(priority)
  const initials = card.assignee?.name ? getInitials(card.assignee.name) : null
  const isAgentCreated = Boolean(card.agentId)

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          role="button"
          tabIndex={0}
          onClick={onClick}
          onMouseEnter={onHover}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
          aria-label={`Card: ${card.title}`}
          className={`km-kc ${priorityCls}${snapshot.isDragging ? ' km-kc--dragging' : ''}`}
        >
          {/* Top row: ID + agent/ai badges */}
          <div className="flex items-center justify-between gap-2">
            <span className="km-kc__id">{displayId(card.id)}</span>
            <div className="flex items-center gap-1">
              {isAgentCreated && (
                <span
                  className="km-mono"
                  style={{ fontSize: 9, letterSpacing: '0.12em', color: 'var(--fg-3)', textTransform: 'uppercase' }}
                >
                  [agent]
                </span>
              )}
            </div>
          </div>

          {/* Label bars */}
          {card.labels && card.labels.length > 0 && (
            <div className="km-labels">
              {card.labels.map((cl) => (
                <span
                  key={cl.label.id}
                  className="km-label-bar"
                  style={{ background: cl.label.color ?? 'var(--fg-3)' }}
                  title={cl.label.name}
                />
              ))}
            </div>
          )}

          {/* Title */}
          <div className="km-kc__title">{card.title}</div>

          {/* Footer meta row */}
          <div className="km-kc__meta">
            <div className="km-kc__meta-left">
              {dueInfo && (
                <span
                  style={{
                    color: dueInfo.overdue ? 'var(--err)' : 'var(--fg-2)',
                    fontWeight: dueInfo.overdue ? 600 : 400,
                  }}
                >
                  {dueInfo.overdue && '✗ '}
                  {dueInfo.text}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {initials ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--fg-1)',
                    color: 'var(--bg-0)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    flexShrink: 0,
                  }}
                  title={card.assignee?.name ?? ''}
                >
                  {initials}
                </span>
              ) : (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--fg-4)',
                    color: 'var(--bg-0)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8,
                    flexShrink: 0,
                  }}
                  title="Unassigned"
                >
                  ?
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </Draggable>
  )
}
