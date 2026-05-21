'use client'

import { useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { preload } from 'swr'
import useSWR from 'swr'
import { Filter, Plus } from 'lucide-react'
import { useBoard } from '@/hooks/useBoard'
import { useRealtime } from '@/hooks/useRealtime'
import { useSession } from '@/hooks/useSession'
import { Topbar } from '@/components/design/Topbar'
import { KanbanBoard } from '@/components/board/KanbanBoard'
import { CardModal } from '@/components/board/CardModal'
import { BoardFilters, filterCards, EMPTY_FILTERS } from '@/components/board/BoardFilters'
import { NewCardModal } from '@/components/board/NewCardModal'
import type { FilterState } from '@/components/board/BoardFilters'
import type { Card, Label, User } from '@/types'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

interface MemberEntry {
  userId?: string
  user?: { id: string; name: string; email: string; isAgent?: boolean }
}

export default function BoardPage() {
  const params = useParams()
  const boardId = params.boardId as string
  const { board, columns, isLoading, moveCard, mutate } = useBoard(boardId)
  const { user, org } = useSession()

  useRealtime({ boardId })

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [newCardOpen, setNewCardOpen] = useState(false)

  // Fetch org members for filter + new-card modal
  const { data: membersData } = useSWR(
    org ? `/api/orgs/${org.id}/members` : null,
    fetcher
  )
  const members: { id: string; name: string }[] = useMemo(() => {
    const raw: MemberEntry[] = membersData?.members ?? []
    return raw
      .filter((m) => !m.user?.isAgent && m.user)
      .map((m) => ({ id: m.user!.id, name: m.user!.name ?? m.user!.email }))
  }, [membersData])

  // Derive unique labels from all cards on the board
  const boardLabels: { id: string; name: string; color: string }[] = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; color: string }>()
    for (const col of columns) {
      const cards = col.cards as (Card & { labels?: { label: Label }[] })[]
      for (const card of cards) {
        for (const cl of card.labels ?? []) {
          if (!seen.has(cl.label.id)) {
            seen.set(cl.label.id, {
              id: cl.label.id,
              name: cl.label.name,
              color: cl.label.color ?? 'var(--fg-3)',
            })
          }
        }
      }
    }
    return Array.from(seen.values())
  }, [columns])

  function preloadCardData(cardId: string) {
    preload(
      [`subcard-tree`, cardId, 3],
      ([, id, d]: [string, string, number]) =>
        fetch(`/api/cards/${id}/children?depth=${d}`).then((r) => r.json())
    )
    preload(
      [`artifacts`, cardId],
      ([, id]: [string, string]) =>
        fetch(`/api/cards/${id}/artifacts`).then((r) => {
          if (!r.ok) throw new Error(String(r.status))
          return r.json()
        })
    )
  }

  function handleCardClick(cardId: string) {
    preloadCardData(cardId)
    setSelectedCardId(cardId)
  }

  async function handleAddCard(columnId: string, title: string) {
    if (!user) return
    const res = await fetch(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, title, assigneeId: user.id }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      console.error('Failed to add card:', res.status, body)
      alert(`Failed to add card: ${body.error ?? res.statusText}`)
      return
    }
    mutate()
  }

  function handleClearFilters() {
    setFilters(EMPTY_FILTERS)
    setSearchQuery('')
  }

  // Apply filters + search to produce filtered columns
  type RichCard = Card & { labels?: { label: Label }[]; assignee?: User | null; priority?: string | null }
  const filteredColumns = useMemo(() => {
    const hasFilter =
      filters.assignees.length > 0 ||
      filters.priorities.length > 0 ||
      filters.labels.length > 0 ||
      searchQuery.trim().length > 0

    if (!hasFilter) return columns

    return columns.map((col) => ({
      ...col,
      cards: filterCards(col.cards as RichCard[], filters, searchQuery),
    }))
  }, [columns, filters, searchQuery])

  const totalCards = columns.reduce((acc, col) => acc + col.cards.length, 0)
  const filteredCardCount = filteredColumns.reduce((acc, col) => acc + col.cards.length, 0)

  if (isLoading) {
    return (
      <div
        className="flex-1 flex items-center justify-center km-mono"
        style={{ color: 'var(--fg-3)', fontSize: 12, letterSpacing: '0.1em' }}
      >
        loading board…
      </div>
    )
  }

  if (!board) {
    return (
      <div
        className="flex-1 flex items-center justify-center km-mono"
        style={{ color: 'var(--fg-3)', fontSize: 12 }}
      >
        board not found
      </div>
    )
  }

  const topbarRight = (
    <div className="flex items-center gap-2">
      <button
        className={`km-btn${filterOpen ? ' km-btn--primary' : ''}`}
        aria-label="Toggle filters"
        aria-expanded={filterOpen}
        aria-controls="board-filter-panel"
        onClick={() => setFilterOpen((v) => !v)}
        style={filterOpen ? {} : {}}
      >
        <Filter size={13} color={filterOpen ? '#fff' : undefined} />
        filter
      </button>
      <button
        className="km-btn km-btn--primary"
        onClick={() => setNewCardOpen(true)}
        aria-label="New card"
      >
        <Plus size={13} color="#fff" />
        new card
      </button>
    </div>
  )

  return (
    <>
      <Topbar
        breadcrumb={`boards / ${board.name.toLowerCase()}`}
        title={board.name}
        mode="board"
        right={topbarRight}
      />

      <div id="board-filter-panel">
        <BoardFilters
          open={filterOpen}
          filters={filters}
          members={members}
          labels={boardLabels}
          currentUserId={user?.id ?? null}
          totalCards={totalCards}
          filteredCards={filteredCardCount}
          searchQuery={searchQuery}
          onFiltersChange={setFilters}
          onSearchChange={setSearchQuery}
          onClear={handleClearFilters}
        />
      </div>

      <main className="flex-1 overflow-hidden">
        <KanbanBoard
          columns={filteredColumns as Parameters<typeof KanbanBoard>[0]['columns']}
          boardId={boardId}
          onCardClick={handleCardClick}
          onCardHover={preloadCardData}
          onMoveCard={moveCard}
          onAddCard={handleAddCard}
        />
      </main>

      <CardModal
        cardId={selectedCardId}
        boardId={boardId}
        onClose={() => setSelectedCardId(null)}
        onUpdate={() => mutate()}
        onDelete={() => {
          mutate()
          setSelectedCardId(null)
        }}
      />

      {newCardOpen && (
        <NewCardModal
          boardId={boardId}
          columns={columns}
          members={members}
          currentUser={user}
          onClose={() => setNewCardOpen(false)}
          onCreated={() => mutate()}
        />
      )}
    </>
  )
}
