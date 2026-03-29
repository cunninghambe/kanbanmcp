'use client'

import { useState } from 'react'
import { Droppable } from '@hello-pangea/dnd'
import { KanbanCard } from './KanbanCard'
import { Badge } from '@/components/ui/Badge'
import type { ColumnWithCards, Card, Label, User } from '@/types'

interface KanbanColumnProps {
  column: ColumnWithCards & {
    cards: (Card & {
      labels?: { label: Label }[]
      assignee?: User | null
    })[]
  }
  onCardClick: (cardId: string) => void
  onAddCard: (columnId: string, title: string) => Promise<void>
}

export function KanbanColumn({ column, onCardClick, onAddCard }: KanbanColumnProps) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      await onAddCard(column.id, title.trim())
      setTitle('')
      setAdding(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex-shrink-0 w-[280px] flex flex-col bg-slate-100 rounded-lg">
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-slate-700 text-sm">{column.name}</h3>
          <Badge>{column.cards.length}</Badge>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="text-slate-400 hover:text-slate-600 transition-colors"
          title="Add card"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* Cards drop zone */}
      <Droppable droppableId={column.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`flex-1 px-2 pb-2 space-y-2 min-h-[2rem] transition-colors rounded-b-lg ${
              snapshot.isDraggingOver ? 'bg-blue-50' : ''
            }`}
          >
            {column.cards.map((card, index) => (
              <KanbanCard
                key={card.id}
                card={card}
                index={index}
                onClick={() => onCardClick(card.id)}
              />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>

      {/* Add card form */}
      {adding ? (
        <form onSubmit={handleAdd} className="px-2 pb-2">
          <textarea
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Card title…"
            rows={2}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleAdd(e as unknown as React.FormEvent)
              }
              if (e.key === 'Escape') {
                setAdding(false)
                setTitle('')
              }
            }}
          />
          <div className="flex gap-2 mt-1.5">
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Adding…' : 'Add Card'}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setTitle('') }}
              className="px-3 py-1.5 text-slate-500 text-xs hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mx-2 mb-2 py-1.5 text-sm text-slate-500 hover:text-slate-700 hover:bg-slate-200 rounded-md transition-colors flex items-center gap-1 px-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add card
        </button>
      )}
    </div>
  )
}
