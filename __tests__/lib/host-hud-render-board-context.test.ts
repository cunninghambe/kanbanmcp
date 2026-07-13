import { describe, it, expect } from 'vitest'
import { renderBoardContext } from '../../src/lib/host-hud/worker'

type Card = { id: string; title: string; priority: string; dueDate: Date | null }

function cards(n: number): Card[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    title: `Card ${i}`,
    priority: 'none',
    dueDate: null,
  }))
}

function board(columns: Array<{ name: string; id: string; cards: Card[] }>) {
  return { name: 'Demo', id: 'b1', columns }
}

const OPTS = { maxCardsPerColumn: 40, maxChars: 16000 }

describe('renderBoardContext', () => {
  it('renders columns and cards with priority and due date', () => {
    const out = renderBoardContext(
      board([
        {
          name: 'Backlog',
          id: 'col1',
          cards: [{ id: 'c1', title: 'Ship it', priority: 'high', dueDate: new Date('2026-07-20T00:00:00Z') }],
        },
      ]),
      undefined,
      OPTS
    )
    expect(out).toContain('Board "Demo" (id b1)')
    expect(out).toContain('Column "Backlog" (id col1)')
    expect(out).toContain('[c1] Ship it (priority high due 2026-07-20)')
  })

  it('marks an empty column with (no cards)', () => {
    const out = renderBoardContext(board([{ name: 'Done', id: 'col2', cards: [] }]), undefined, OPTS)
    expect(out).toContain('(no cards)')
  })

  it('caps cards per column and notes the omission', () => {
    const out = renderBoardContext(
      board([{ name: 'Backlog', id: 'col1', cards: cards(100) }]),
      undefined,
      { maxCardsPerColumn: 40, maxChars: 100000 }
    )
    const cardLines = out.split('\n').filter((l) => /^\s+- \[/.test(l))
    expect(cardLines).toHaveLength(40)
    expect(out).toContain('more cards omitted')
    // The 41st card must not appear.
    expect(out).not.toContain('Card 40')
  })

  it('does not emit an omission note when exactly at the cap', () => {
    const out = renderBoardContext(
      board([{ name: 'Backlog', id: 'col1', cards: cards(40) }]),
      undefined,
      { maxCardsPerColumn: 40, maxChars: 100000 }
    )
    expect(out).not.toContain('omitted')
  })

  it('appends a recent-movements block when provided', () => {
    const out = renderBoardContext(
      board([{ name: 'Backlog', id: 'col1', cards: cards(1) }]),
      'Recent movements:\n  MOVE-MARKER',
      OPTS
    )
    expect(out).toContain('MOVE-MARKER')
  })

  it('hard-truncates output that exceeds maxChars, ending with a marker', () => {
    const out = renderBoardContext(
      board([{ name: 'Backlog', id: 'col1', cards: cards(1000) }]),
      undefined,
      { maxCardsPerColumn: 1000, maxChars: 500 }
    )
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out).toMatch(/\[board context truncated\]$/)
  })

  it('does not truncate when already within maxChars', () => {
    const out = renderBoardContext(board([{ name: 'A', id: 'c', cards: cards(1) }]), undefined, OPTS)
    expect(out).not.toContain('board context truncated')
  })
})
