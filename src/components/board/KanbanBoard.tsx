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
  onCardHover?: (cardId: string) => void
  onMoveCard: (
    cardId: string,
    sourceColumnId: string,
    destColumnId: string,
    newPosition: number,
    siblingPositions: { id: string; position: number }[]
  ) => Promise<void>
  onAddCard: (columnId: string, title: string) => Promise<void>
}

export function KanbanBoard({ columns, onCardClick, onCardHover, onMoveCard, onAddCard }: KanbanBoardProps) {
  function onDragEnd(result: DropResult) {
    const { source, destination, draggableId } = result

    if (!destination) return
    if (source.droppableId === destination.droppableId && source.index === destination.index) return

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
      <div
        className="flex overflow-x-auto h-full"
        style={{ gap: 12, padding: 16, background: 'var(--bg-0)', alignItems: 'flex-start' }}
      >
        {columns.map((col) => (
          <KanbanColumn key={col.id} column={col} onCardClick={onCardClick} onCardHover={onCardHover} onAddCard={onAddCard} />
        ))}
        {columns.length === 0 && (
          <div
            className="flex items-center justify-center w-full km-mono"
            style={{ color: 'var(--fg-3)', fontSize: 12 }}
          >
            no columns found
          </div>
        )}
      </div>
    </DragDropContext>
  )
}
