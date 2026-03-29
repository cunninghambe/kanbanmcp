'use client'

import { Droppable, Draggable } from '@hello-pangea/dnd'
import { Button } from '@/components/ui/Button'
import type { Card } from '@/types'

interface BacklogListProps {
  cards: Card[]
  sprintId: string | null
  onAddToSprint: (cardId: string) => Promise<void>
}

type Priority = 'none' | 'low' | 'medium' | 'high' | 'critical'

function getPriorityBadgeClasses(priority: string): string {
  switch (priority as Priority) {
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
      return 'bg-gray-200 text-gray-600'
  }
}

export function BacklogList({ cards, sprintId, onAddToSprint }: BacklogListProps) {
  if (cards.length === 0) {
    return (
      <div className="text-center py-8 text-slate-400 text-sm">
        No backlog cards — all cards are in a sprint
      </div>
    )
  }

  return (
    <Droppable droppableId="backlog">
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className={`space-y-2 min-h-[2rem] rounded-md transition-colors ${
            snapshot.isDraggingOver ? 'bg-blue-50' : ''
          }`}
        >
          {cards.map((card, index) => {
            const priority = (card as Card & { priority?: string }).priority ?? 'none'
            const priorityLabel =
              priority && priority !== 'none'
                ? priority.charAt(0).toUpperCase() + priority.slice(1)
                : null

            return (
              <Draggable key={card.id} draggableId={card.id} index={index}>
                {(dragProvided, dragSnapshot) => (
                  <div
                    ref={dragProvided.innerRef}
                    {...dragProvided.draggableProps}
                    {...dragProvided.dragHandleProps}
                    className={`flex items-center justify-between bg-white rounded-md border px-4 py-3 transition-shadow ${
                      dragSnapshot.isDragging
                        ? 'border-blue-300 shadow-md'
                        : 'border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {priorityLabel && (
                        <span
                          className={`text-xs font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 ${getPriorityBadgeClasses(priority)}`}
                        >
                          {priorityLabel}
                        </span>
                      )}
                      <span className="text-sm text-slate-800 truncate">{card.title}</span>
                    </div>
                    {sprintId && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onAddToSprint(card.id)}
                        className="flex-shrink-0 ml-2"
                      >
                        Add to Sprint
                      </Button>
                    )}
                  </div>
                )}
              </Draggable>
            )
          })}
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  )
}
