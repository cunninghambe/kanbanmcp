'use client'

import { Droppable, Draggable } from '@hello-pangea/dnd'
import { Button } from '@/components/ui/Button'
import type { Card } from '@/types'

interface BacklogListProps {
  cards: Card[]
  sprintId: string | null
  onAddToSprint: (cardId: string) => Promise<void>
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
          {cards.map((card, index) => (
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
                  <span className="text-sm text-slate-800">{card.title}</span>
                  {sprintId && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onAddToSprint(card.id)}
                    >
                      Add to Sprint
                    </Button>
                  )}
                </div>
              )}
            </Draggable>
          ))}
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  )
}
