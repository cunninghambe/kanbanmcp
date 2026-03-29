'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { useBoard } from '@/hooks/useBoard'
import { useRealtime } from '@/hooks/useRealtime'
import { Header } from '@/components/layout/Header'
import { KanbanBoard } from '@/components/board/KanbanBoard'
import { CardModal } from '@/components/board/CardModal'

export default function BoardPage() {
  const params = useParams()
  const boardId = params.boardId as string
  const { board, columns, isLoading, moveCard, mutate } = useBoard(boardId)

  // SSE real-time sync — board updates from agent MCP calls appear within ~2s
  useRealtime({ boardId })
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)

  async function handleAddCard(columnId: string, title: string) {
    await fetch(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, title }),
    })
    mutate()
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        Loading board…
      </div>
    )
  }

  if (!board) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        Board not found
      </div>
    )
  }

  return (
    <>
      <Header
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: board.name },
        ]}
      />
      <main className="flex-1 p-4 overflow-hidden flex flex-col">
        <KanbanBoard
          columns={columns as Parameters<typeof KanbanBoard>[0]['columns']}
          boardId={boardId}
          onCardClick={setSelectedCardId}
          onMoveCard={moveCard}
          onAddCard={handleAddCard}
        />
      </main>

      <CardModal
        cardId={selectedCardId}
        boardId={boardId}
        onClose={() => setSelectedCardId(null)}
        onUpdate={() => mutate()}
        onDelete={() => { mutate(); setSelectedCardId(null) }}
      />
    </>
  )
}
