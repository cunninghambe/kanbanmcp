'use client'

import { useState } from 'react'
import { Droppable } from '@hello-pangea/dnd'
import { Plus } from 'lucide-react'
import { KanbanCard } from './KanbanCard'
import type { ColumnWithCards, Card, Label, User } from '@/types'

interface KanbanColumnProps {
  column: ColumnWithCards & {
    cards: (Card & {
      labels?: { label: Label }[]
      assignee?: User | null
    })[]
  }
  onCardClick: (cardId: string) => void
  onCardHover?: (cardId: string) => void
  onAddCard: (columnId: string, title: string) => Promise<void>
}

const COLUMN_ACCENT: Record<string, string> = {
  todo: 'km-pip',
  'in progress': 'km-pip km-pip--accent',
  doing: 'km-pip km-pip--accent',
  'in review': 'km-pip km-pip--warn',
  review: 'km-pip km-pip--warn',
  done: 'km-pip km-pip--ok',
}

export function KanbanColumn({ column, onCardClick, onCardHover, onAddCard }: KanbanColumnProps) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const count = String(column.cards.length).padStart(2, '0')
  const nameLower = column.name.toLowerCase()
  const pipClass = COLUMN_ACCENT[nameLower] ?? 'km-pip'

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
    <div
      style={{
        width: 280,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
        minHeight: 0,
      }}
    >
      {/* Column header */}
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'var(--bg-2)',
        }}
      >
        <span className={pipClass} />
        <span
          className="km-mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-1)',
            fontWeight: 500,
            flex: 1,
          }}
        >
          {nameLower}
        </span>
        <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.08em' }}>
          {count}
        </span>
        <button
          onClick={() => setAdding(true)}
          aria-label={`Add card to ${column.name}`}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--fg-3)',
            display: 'flex',
          }}
        >
          <Plus size={13} />
        </button>
      </div>

      {/* Cards drop zone */}
      <Droppable droppableId={column.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            style={{
              flex: 1,
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              minHeight: 32,
              background: snapshot.isDraggingOver ? 'var(--bg-3)' : undefined,
              transition: `background var(--dur-micro) var(--ease-out)`,
            }}
          >
            {column.cards.map((card, index) => (
              <KanbanCard
                key={card.id}
                card={card}
                index={index}
                onClick={() => onCardClick(card.id)}
                onHover={onCardHover ? () => onCardHover(card.id) : undefined}
              />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>

      {/* Quick-add form */}
      {adding ? (
        <form onSubmit={handleAdd} style={{ padding: '0 8px 8px' }}>
          <textarea
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Card title…"
            rows={2}
            className="km-input"
            style={{ height: 'auto', resize: 'none', marginBottom: 6 }}
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
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className={`km-btn km-btn--primary km-btn--sm${submitting || !title.trim() ? ' opacity-50 cursor-not-allowed' : ''}`}
            >
              {submitting ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              className="km-btn km-btn--ghost km-btn--sm"
              onClick={() => { setAdding(false); setTitle('') }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="km-btn km-btn--ghost"
          style={{
            margin: '0 8px 8px',
            justifyContent: 'flex-start',
            height: 28,
            fontSize: 12,
            color: 'var(--fg-3)',
            gap: 6,
          }}
        >
          <Plus size={12} />
          <span>add card</span>
        </button>
      )}
    </div>
  )
}
