// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SituationRail } from '../../src/app/(app)/hud/_components/SituationRail'

function pertinent(overrides: Record<string, unknown> = {}) {
  return {
    board: { id: 'board-1', name: 'Board' },
    overdue: [],
    stalled: [],
    dueSoon: [],
    movedThisSession: [],
    counts: { overdue: 0, stalled: 0, aging: 0, total: 0, dueSoon: 0, movedThisSession: 0 },
    ...overrides,
  }
}

describe('SituationRail', () => {
  it('POSITIVE: renders due-this-week cards deep-linked to the board with the card id', () => {
    render(
      <SituationRail
        pertinent={pertinent({ dueSoon: [{ id: 'c-1', title: 'Send contract', priority: 'high', columnName: 'Doing', ageDays: 1 }] })}
        inFlight={0}
        pending={0}
        boardId="board-1"
      />
    )

    expect(screen.getByText('due this week · 1')).toBeInTheDocument()
    const link = screen.getByText('Send contract').closest('a')
    expect(link).toHaveAttribute('href', '/board/board-1?card=c-1')
  })

  it('POSITIVE: renders moved-this-session rows in the "«title»: «from» → «to»" format, deep-linked', () => {
    render(
      <SituationRail
        pertinent={pertinent({
          movedThisSession: [
            { cardId: 'c-2', cardTitle: 'Spoonworks', fromColumn: 'Backlog', toColumn: 'Review', movedAt: '2026-07-13T10:00:00.000Z' },
          ],
        })}
        inFlight={0}
        pending={0}
        boardId="board-1"
      />
    )

    expect(screen.getByText('moved this session · 1')).toBeInTheDocument()
    const link = screen.getByText('Spoonworks: Backlog → Review').closest('a')
    expect(link).toHaveAttribute('href', '/board/board-1?card=c-2')
  })

  it('EDGE: a null fromColumn renders as "new" in the movement row', () => {
    render(
      <SituationRail
        pertinent={pertinent({
          movedThisSession: [
            { cardId: 'c-3', cardTitle: 'New Idea', fromColumn: null, toColumn: 'Backlog', movedAt: '2026-07-13T10:00:00.000Z' },
          ],
        })}
        inFlight={0}
        pending={0}
        boardId="board-1"
      />
    )

    expect(screen.getByText('New Idea: new → Backlog')).toBeInTheDocument()
  })

  it('POSITIVE: overdue and stalled rows also deep-link to ?card=<id>', () => {
    render(
      <SituationRail
        pertinent={pertinent({
          overdue: [{ id: 'c-4', title: 'Overdue Card', priority: 'high', columnName: 'Doing', ageDays: 4 }],
          stalled: [{ id: 'c-5', title: 'Stalled Card', priority: 'low', columnName: 'Doing', ageDays: 5 }],
        })}
        inFlight={0}
        pending={0}
        boardId="board-1"
      />
    )

    expect(screen.getByText('Overdue Card').closest('a')).toHaveAttribute('href', '/board/board-1?card=c-4')
    expect(screen.getByText('Stalled Card').closest('a')).toHaveAttribute('href', '/board/board-1?card=c-5')
  })

  it('EDGE: caps rendered rows at 6 per group while the header count shows the full total', () => {
    const dueSoon = Array.from({ length: 8 }, (_, i) => ({
      id: `c-${i}`,
      title: `Card ${i}`,
      priority: 'medium',
      columnName: 'Doing',
      ageDays: 0,
    }))
    render(<SituationRail pertinent={pertinent({ dueSoon })} inFlight={0} pending={0} boardId="board-1" />)

    expect(screen.getByText('due this week · 8')).toBeInTheDocument()
    expect(screen.getAllByText(/^Card \d$/)).toHaveLength(6)
  })

  it('NEGATIVE: without a boardId, group rows render without links', () => {
    render(
      <SituationRail
        pertinent={pertinent({ dueSoon: [{ id: 'c-6', title: 'No Board Card', priority: 'medium', columnName: 'Doing', ageDays: 0 }] })}
        inFlight={0}
        pending={0}
        boardId={null}
      />
    )

    expect(screen.getByText('No Board Card').closest('a')).toBeNull()
  })
})
