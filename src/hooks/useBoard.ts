'use client'

import useSWR from 'swr'
import type { BoardWithColumns, ColumnWithCards } from '@/types'

const fetcher = (url: string) =>
  fetch(url)
    .then((r) => r.json())
    .then((json) => json.board ?? json)

export function useBoard(boardId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<BoardWithColumns>(
    boardId ? `/api/boards/${boardId}` : null,
    fetcher
  )

  async function moveCard(
    cardId: string,
    sourceColumnId: string,
    destColumnId: string,
    newPosition: number,
    siblingPositions: { id: string; position: number }[]
  ) {
    if (!data) return

    // Optimistic update
    const optimistic: BoardWithColumns = {
      ...data,
      columns: data.columns.map((col) => {
        if (col.id === sourceColumnId && col.id !== destColumnId) {
          return { ...col, cards: col.cards.filter((c) => c.id !== cardId) }
        }
        if (col.id === destColumnId) {
          const card = data.columns
            .flatMap((c) => c.cards)
            .find((c) => c.id === cardId)
          if (!card) return col
          const updatedCard = { ...card, columnId: destColumnId, position: newPosition }
          const otherCards = col.cards.filter((c) => c.id !== cardId)
          // Insert at correct position
          const newCards = [...otherCards, updatedCard].sort((a, b) => {
            const aPos = siblingPositions.find((s) => s.id === a.id)?.position ?? a.position
            const bPos = siblingPositions.find((s) => s.id === b.id)?.position ?? b.position
            return aPos - bPos
          })
          return { ...col, cards: newCards }
        }
        return col
      }),
    }

    mutate(optimistic, false)

    try {
      const res = await fetch(`/api/cards/${cardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columnId: destColumnId,
          position: newPosition,
          siblingPositions,
        }),
      })
      if (!res.ok) throw new Error(String(res.status))
    } catch {
      // Roll back to previous data on error
      mutate(data, false)
    } finally {
      mutate()
    }
  }

  async function mutateCard(cardId: string, updates: Record<string, unknown>) {
    if (!data) return
    const optimistic: BoardWithColumns = {
      ...data,
      columns: data.columns.map((col) => ({
        ...col,
        cards: col.cards.map((c) =>
          c.id === cardId ? { ...c, ...updates } : c
        ),
      })),
    }
    mutate(optimistic, false)
    try {
      const res = await fetch(`/api/cards/${cardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!res.ok) throw new Error(String(res.status))
    } catch {
      // Roll back to previous data on error
      mutate(data, false)
    } finally {
      mutate()
    }
  }

  return {
    board: data ?? null,
    columns: (data?.columns ?? []) as ColumnWithCards[],
    isLoading,
    isError: !!error,
    mutate,
    mutateCard,
    moveCard,
  }
}
