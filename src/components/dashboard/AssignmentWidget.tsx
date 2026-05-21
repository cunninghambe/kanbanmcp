'use client'

import { useState } from 'react'
import useSWR from 'swr'
import type { AssignmentCard } from '@/app/api/me/assignments/route'

export { type AssignmentCard }
export const ASSIGNMENTS_SWR_KEY = '/api/me/assignments'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

export type AssignmentsData = {
  asAssignee: AssignmentCard[]
  asReviewer: AssignmentCard[]
  asApprover: AssignmentCard[]
  overdue: AssignmentCard[]
}

/**
 * Data hook for the dashboard assignment queues.
 * Returns structured assignment data fetched from /api/me/assignments.
 * Refreshes every 30 seconds.
 */
export function useAssignments(): {
  data: AssignmentsData | undefined
  isLoading: boolean
  error: Error | undefined
} {
  const { data, error, isLoading } = useSWR<AssignmentsData>(ASSIGNMENTS_SWR_KEY, fetcher, {
    refreshInterval: 30_000,
  })
  return { data, isLoading, error }
}

// ---------------------------------------------------------------------------
// Legacy accordion widget — preserved for test compatibility.
// The Phase 3 dashboard page uses useAssignments() + QueueTable instead.
// ---------------------------------------------------------------------------

function Section({
  title,
  cards,
  overdue,
  onCardClick,
}: {
  title: string
  cards: AssignmentCard[]
  overdue?: boolean
  onCardClick: (card: AssignmentCard) => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <div className={`rounded-lg border ${overdue ? 'border-red-300' : 'border-slate-200'} overflow-hidden`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-slate-50 text-left transition-colors"
        aria-expanded={open}
      >
        <span className="font-medium text-slate-800 flex items-center gap-2">
          {overdue && (
            <span className="text-red-500" aria-label="overdue">
              &#9888;
            </span>
          )}
          {title}
          <span className="ml-1 text-xs font-normal text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
            {cards.length}
          </span>
        </span>
        <svg
          className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <ul className="divide-y divide-slate-100">
          {cards.length === 0 ? (
            <li className="px-4 py-3 text-sm text-slate-400">Nothing here</li>
          ) : (
            cards.map((card) => (
              <li key={card.id}>
                <button
                  onClick={() => onCardClick(card)}
                  className={`w-full text-left px-4 py-3 text-sm hover:bg-slate-50 transition-colors ${
                    overdue ? 'hover:bg-red-50' : ''
                  }`}
                >
                  <span className="font-medium text-slate-800 block truncate">{card.title}</span>
                  <span className="text-xs text-slate-500">
                    {card.boardName} &middot; {card.columnName}
                    {card.dueDate && (
                      <>
                        {' '}&middot; Due {new Date(card.dueDate).toLocaleDateString()}
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

interface AssignmentWidgetProps {
  onCardClick: (boardId: string, cardId: string) => void
}

/**
 * Legacy assignment widget — three collapsible sections.
 * Kept for backward compatibility; the Phase 3 dashboard uses
 * useAssignments() + QueueTable for the restyled view.
 */
export function AssignmentWidget({ onCardClick }: AssignmentWidgetProps) {
  const { data, error, isLoading } = useSWR<AssignmentsData>(ASSIGNMENTS_SWR_KEY, fetcher, {
    refreshInterval: 30_000,
  })

  if (isLoading) {
    return (
      <div className="text-slate-400 text-sm py-4" aria-label="Loading assignments">
        Loading assignments&hellip;
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-red-500 text-sm py-4" role="alert">
        Failed to load assignments
      </div>
    )
  }

  if (!data) return null

  const needsAction = [
    ...data.asReviewer.map((c) => ({ ...c, _kind: 'reviewer' as const })),
    ...data.asApprover.map((c) => ({ ...c, _kind: 'approver' as const })),
  ]

  function handleClick(card: AssignmentCard) {
    onCardClick(card.boardId, card.id)
  }

  return (
    <div className="space-y-3">
      <Section title="Needs your action" cards={needsAction} onCardClick={handleClick} />
      <Section title="Assigned to you" cards={data.asAssignee} onCardClick={handleClick} />
      <Section title="Overdue" cards={data.overdue} overdue onCardClick={handleClick} />
    </div>
  )
}
