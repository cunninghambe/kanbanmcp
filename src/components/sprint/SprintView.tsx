'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { DragDropContext, Droppable, type DropResult } from '@hello-pangea/dnd'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { BacklogList } from './BacklogList'
import type { Sprint, Card, Column } from '@/types'

const fetcher = (url: string) =>
  fetch(url)
    .then((r) => r.json())
    .then((json) => json.board ?? json)

interface SprintViewProps {
  boardId: string
}

export function SprintView({ boardId }: SprintViewProps) {
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(null)

  const { data: sprintsData, mutate: mutateSprints } = useSWR(
    `/api/sprints?boardId=${boardId}`,
    fetcher
  )
  const { data: boardData, mutate: mutateBoard } = useSWR(
    `/api/boards/${boardId}`,
    fetcher
  )

  const sprints: Sprint[] = sprintsData?.sprints ?? []
  const activeSprint = sprints.find((s) => s.status === 'ACTIVE') ?? sprints[0] ?? null
  const currentSprint = selectedSprintId
    ? sprints.find((s) => s.id === selectedSprintId) ?? activeSprint
    : activeSprint

  const { data: sprintCardsData, mutate: mutateSprintCards } = useSWR(
    currentSprint ? `/api/sprints/${currentSprint.id}/cards` : null,
    fetcher
  )

  const sprintCards: Card[] = sprintCardsData?.cards ?? []
  const columns: Column[] = boardData?.columns ?? []
  const allCards: Card[] = (boardData?.columns ?? []).flatMap(
    (c: { cards: Card[] }) => c.cards
  )
  const backlogCards = allCards.filter((c: Card) => !c.sprintId)

  async function handleCompleteSprint() {
    if (!currentSprint || !confirm('Complete this sprint?')) return
    await fetch(`/api/sprints/${currentSprint.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMPLETED' }),
    })
    mutateSprints()
    mutateSprintCards()
  }

  async function handleAddToSprint(cardId: string) {
    if (!currentSprint) return
    await fetch(`/api/sprints/${currentSprint.id}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId }),
    })
    mutateSprintCards()
    mutateBoard()
  }

  async function handleDragEnd(result: DropResult) {
    const { source, destination, draggableId } = result
    if (!destination) return
    // Drag from backlog to sprint drop zone
    if (source.droppableId === 'backlog' && destination.droppableId === 'sprint-dropzone') {
      await handleAddToSprint(draggableId)
    }
  }

  // Group sprint cards by column
  const cardsByColumn = columns.map((col) => ({
    column: col,
    cards: sprintCards.filter((c) => c.columnId === col.id),
  }))

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="space-y-6">
        {/* Sprint selector */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <select
              className="px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={currentSprint?.id ?? ''}
              onChange={(e) => setSelectedSprintId(e.target.value || null)}
            >
              {sprints.length === 0 && <option value="">No sprints</option>}
              {sprints.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.status})
                </option>
              ))}
            </select>
            {currentSprint && (
              <Badge>
                {new Date(currentSprint.startDate).toLocaleDateString()} &ndash;{' '}
                {new Date(currentSprint.endDate).toLocaleDateString()}
              </Badge>
            )}
          </div>
          {currentSprint?.status === 'ACTIVE' && (
            <Button variant="secondary" onClick={handleCompleteSprint}>
              Complete Sprint
            </Button>
          )}
        </div>

        {/* Cards by column — wrapped in a droppable sprint zone */}
        {currentSprint ? (
          <Droppable droppableId="sprint-dropzone">
            {(provided, snapshot) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                className={`rounded-lg transition-colors ${
                  snapshot.isDraggingOver ? 'bg-blue-50 ring-2 ring-blue-300' : ''
                }`}
              >
                <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide mb-3">
                  Sprint Cards ({sprintCards.length})
                  {snapshot.isDraggingOver && (
                    <span className="ml-2 text-blue-500 normal-case font-normal">
                      Drop to add to sprint
                    </span>
                  )}
                </h2>
                {cardsByColumn.map(({ column, cards }) =>
                  cards.length > 0 ? (
                    <div key={column.id} className="mb-4">
                      <h3 className="text-sm font-medium text-slate-500 mb-2 flex items-center gap-2">
                        {column.name}
                        <Badge>{cards.length}</Badge>
                      </h3>
                      <div className="space-y-2">
                        {cards.map((card) => (
                          <div
                            key={card.id}
                            className="bg-white rounded-md border border-slate-200 px-4 py-3 text-sm text-slate-800"
                          >
                            {card.title}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null
                )}
                {sprintCards.length === 0 && (
                  <p className="text-slate-400 text-sm text-center py-8">
                    No cards in this sprint yet — drag cards from the backlog below
                  </p>
                )}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        ) : (
          <p className="text-slate-400 text-sm">No sprint selected</p>
        )}

        {/* Backlog */}
        <div>
          <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide mb-3">
            Backlog ({backlogCards.length})
          </h2>
          <BacklogList
            cards={backlogCards}
            sprintId={currentSprint?.id ?? null}
            onAddToSprint={handleAddToSprint}
          />
        </div>
      </div>
    </DragDropContext>
  )
}
