'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { preload } from 'swr'
import useSWR from 'swr'
import { Filter, Plus } from 'lucide-react'
import { useBoard } from '@/hooks/useBoard'
import { useRealtime } from '@/hooks/useRealtime'
import { useSession } from '@/hooks/useSession'
import { useClaudeProjects } from '@/hooks/useClaudeProjects'
import { Topbar } from '@/components/design/Topbar'
import { KanbanBoard } from '@/components/board/KanbanBoard'
import { CardModal } from '@/components/board/CardModal'
import { BoardFilters, filterCards, EMPTY_FILTERS } from '@/components/board/BoardFilters'
import { NewCardModal } from '@/components/board/NewCardModal'
import { slugifyBoardName } from '@/lib/card-execution/projects'
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
  return (
    <Suspense fallback={null}>
      <BoardPageContent />
    </Suspense>
  )
}

function BoardPageContent() {
  const params = useParams()
  const boardId = params.boardId as string
  const router = useRouter()
  const searchParams = useSearchParams()
  const { board, columns, isLoading, moveCard, mutate } = useBoard(boardId)
  const { user, org } = useSession()

  useRealtime({ boardId })

  const { projects: claudeProjects, mutate: mutateClaudeProjects } = useClaudeProjects()
  const isRegistered = board ? claudeProjects.includes(slugifyBoardName(board.name)) : true

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [newCardOpen, setNewCardOpen] = useState(false)
  const [registerModalOpen, setRegisterModalOpen] = useState(false)
  const [registerRepoPath, setRegisterRepoPath] = useState('')
  const [registerError, setRegisterError] = useState<string | null>(null)
  const [registerSubmitting, setRegisterSubmitting] = useState(false)

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

  // Deep-link: `?card=<id>` opens that card's modal once the board has loaded,
  // provided the card actually exists on this board. Unknown/foreign ids are
  // ignored silently. Applies once per board, not on every board refetch — but
  // the App Router reuses this component instance across param-only
  // navigation (e.g. switching boards from a link), so the latch must reset
  // whenever boardId changes or a later deep link on a new board would be
  // silently dropped.
  const deepLinkAppliedRef = useRef(false)
  useEffect(() => {
    deepLinkAppliedRef.current = false
  }, [boardId])
  useEffect(() => {
    const cardParam = searchParams.get('card')
    const canApply =
      !deepLinkAppliedRef.current &&
      !isLoading &&
      !!board &&
      !!cardParam &&
      columns.some((col) => col.cards.some((c) => c.id === cardParam))
    if (canApply) {
      deepLinkAppliedRef.current = true
      setSelectedCardId(cardParam)
    }
  }, [isLoading, board, columns, searchParams])

  function closeCardModal() {
    setSelectedCardId(null)
    if (!searchParams.get('card')) return
    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.delete('card')
    const query = nextParams.toString()
    router.replace(query ? `/board/${boardId}?${query}` : `/board/${boardId}`)
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

  async function handleRegisterProject(e: React.FormEvent) {
    e.preventDefault()
    const repoPath = registerRepoPath.trim()
    if (!repoPath) return
    setRegisterSubmitting(true)
    setRegisterError(null)
    try {
      const res = await fetch(`/api/boards/${boardId}/register-claude-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setRegisterError(body.error ?? res.statusText)
        return
      }
      await mutateClaudeProjects()
      setRegisterModalOpen(false)
      setRegisterRepoPath('')
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setRegisterSubmitting(false)
    }
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
      {!isRegistered && (
        <button
          className="km-btn km-mono"
          onClick={() => setRegisterModalOpen(true)}
          aria-label="Register Claude project"
          style={{ color: 'var(--warn)', fontSize: 11 }}
        >
          register claude project
        </button>
      )}
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
        onClose={closeCardModal}
        onUpdate={() => mutate()}
        onDelete={() => {
          mutate()
          closeCardModal()
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

      {registerModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Register Claude project"
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <form
            onSubmit={handleRegisterProject}
            style={{
              background: 'var(--bg-1)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: 24,
              width: 360,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div className="km-mono" style={{ fontSize: 12, color: 'var(--fg-0)' }}>
              register claude project
            </div>
            <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
              project slug: {slugifyBoardName(board?.name ?? '')}
            </div>
            <label htmlFor="register-repo-path" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              repo path
            </label>
            <input
              id="register-repo-path"
              type="text"
              placeholder="e.g. /opt/my-project"
              value={registerRepoPath}
              onChange={(e) => setRegisterRepoPath(e.target.value)}
              className="km-input"
              style={{ fontSize: 12, height: 32 }}
              autoFocus
            />
            {registerError && (
              <div
                className="km-mono"
                style={{ fontSize: 10, color: 'var(--err)' }}
                role="alert"
              >
                {registerError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="km-btn km-btn--ghost km-btn--sm"
                onClick={() => {
                  setRegisterModalOpen(false)
                  setRegisterRepoPath('')
                  setRegisterError(null)
                }}
              >
                cancel
              </button>
              <button
                type="submit"
                disabled={registerSubmitting || !registerRepoPath.trim()}
                className="km-btn km-btn--primary km-btn--sm"
              >
                {registerSubmitting ? 'registering…' : 'register'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
