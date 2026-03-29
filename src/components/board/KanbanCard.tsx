'use client'

import { Draggable } from '@hello-pangea/dnd'
import { Badge } from '@/components/ui/Badge'
import type { Card, Label, User } from '@/types'

interface KanbanCardProps {
  card: Card & {
    labels?: { label: Label }[]
    assignee?: User | null
  }
  index: number
  onClick: () => void
}

function getRelativeDate(date: Date | string | null): { text: string; overdue: boolean } | null {
  if (!date) return null
  const d = new Date(date)
  const now = new Date()
  const diffMs = d.getTime() - now.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  const overdue = diffDays < 0
  if (diffDays === 0) return { text: 'Due today', overdue }
  if (diffDays === -1) return { text: 'Yesterday', overdue: true }
  if (diffDays === 1) return { text: 'Tomorrow', overdue: false }
  if (diffDays < 0) return { text: `${Math.abs(diffDays)}d overdue`, overdue: true }
  return { text: `Due in ${diffDays}d`, overdue: false }
}

export function KanbanCard({ card, index, onClick }: KanbanCardProps) {
  const dueInfo = getRelativeDate(card.dueDate)
  const initials = card.assignee?.name
    ?.split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() ?? null

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={onClick}
          className={`
            bg-white rounded-md border border-slate-200 p-3 cursor-pointer
            hover:border-blue-300 hover:shadow-sm transition-all
            ${snapshot.isDragging ? 'shadow-lg rotate-1 border-blue-400' : ''}
          `}
        >
          {/* Labels */}
          {card.labels && card.labels.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {card.labels.map((cl) => (
                <span
                  key={cl.label.id}
                  className="h-1.5 w-8 rounded-full"
                  style={{ backgroundColor: cl.label.color }}
                  title={cl.label.name}
                />
              ))}
            </div>
          )}

          <p className="text-sm text-slate-800 font-medium leading-snug">{card.title}</p>

          <div className="flex items-center justify-between mt-2 gap-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* Due date */}
              {dueInfo && (
                <span
                  className={`text-xs ${dueInfo.overdue ? 'text-red-600 font-medium' : 'text-slate-400'}`}
                >
                  {dueInfo.text}
                </span>
              )}

              {/* Agent-created indicator */}
              {card.agentId && (
                <Badge className="text-xs">Agent</Badge>
              )}
            </div>

            {/* Assignee avatar */}
            {initials && (
              <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                {initials}
              </div>
            )}
          </div>
        </div>
      )}
    </Draggable>
  )
}
