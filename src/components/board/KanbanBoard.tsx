'use client'

import { DragDropContext, DropResult } from '@hello-pangea/dnd'
import { KanbanColumn } from './KanbanColumn'
import type { ColumnWithCards, Card, Label, User } from '@/types'

interface KanbanBoardProps {
  columns: (ColumnWithCards & {
    cards: (Card & {
      labels?: { label: Label }[]
      assignee?: User | null
    })[]
  })[]
  boardId: string
  onCardClick: (cardId: string) => void
  onMoveCard: (
    cardId: string,
    sourceColumnId: string,
    destColumnId: string,
    newPosition: number,
    siblingPositions: { id: string; position: number }[]
  ) => Promise<void>
  onAddCard: (columnId: string, title: string) => Promise<void>
}

export function KanbanBoard({ columns, onCardClick, onMoveCard, onAddCard }: KanbanBoardProps) {
  function onDragEnd(result: DropResult) {
    const { source, destination, draggableId } = result

    if (!destination) return
    if (
      source.droppableId === destination.droppableId &&
      source.index === destination.index
    ) return

    const destColumn = columns.find((c) => c.id === destination.droppableId)
    if (!destColumn) return

    // Compute new positions for cards in the destination column
    const destCards = [...destColumn.cards.filter((c) => c.id !== draggableId)]
    destCards.splice(destination.index, 0, { id: draggableId } as Card)

    const siblingPositions = destCards.map((card, idx) => ({
      id: card.id,
      position: idx,
    }))

    onMoveCard(
      draggableId,
      source.droppableId,
      destination.droppableId,
      destination.index,
      siblingPositions
    )
  }

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="flex gap-4 overflow-x-auto pb-4 h-full">
        {columns.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            onCardClick={onCardClick}
            onAddCard={onAddCard}
          />
        ))}
        {columns.length === 0 && (
          <div className="flex items-center justify-center w-full text-slate-400 text-sm">
            No columns found
          </div>
        )}
      </div>
    </DragDropContext>
  )
}
