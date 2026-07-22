// @vitest-environment jsdom
/**
 * Tests for the board page's `?card=<id>` deep-link handling: opening the card
 * modal for a valid id present on the loaded board, ignoring unknown/foreign
 * ids, and clearing the param via router.replace when the modal closes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }))
const searchParamsState = vi.hoisted(() => ({ value: '' }))
const routeState = vi.hoisted(() => ({ boardId: 'board-1' }))

vi.mock('next/navigation', () => ({
  useParams: () => ({ boardId: routeState.boardId }),
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(searchParamsState.value),
}))

const boardState = vi.hoisted(() => ({
  board: { id: 'board-1', name: 'Test Board' } as { id: string; name: string } | null,
  columns: [] as { id: string; cards: { id: string }[] }[],
  isLoading: false,
}))

vi.mock('@/hooks/useBoard', () => ({
  useBoard: () => ({
    board: boardState.board,
    columns: boardState.columns,
    isLoading: boardState.isLoading,
    moveCard: vi.fn(),
    mutate: vi.fn(),
  }),
}))

vi.mock('@/hooks/useSession', () => ({
  useSession: () => ({ user: { id: 'user-1', name: 'Brad' }, org: { id: 'org-1' } }),
}))
vi.mock('@/hooks/useRealtime', () => ({ useRealtime: () => {} }))
vi.mock('@/hooks/useClaudeProjects', () => ({
  useClaudeProjects: () => ({ projects: [], mutate: vi.fn() }),
}))

vi.mock('swr', () => ({
  default: () => ({ data: undefined, error: undefined, isLoading: false }),
  preload: vi.fn(),
}))

vi.mock('@/components/board/KanbanBoard', () => ({ KanbanBoard: () => null }))
vi.mock('@/components/board/NewCardModal', () => ({ NewCardModal: () => null }))
vi.mock('@/components/board/BoardFilters', () => ({
  BoardFilters: () => null,
  filterCards: (cards: unknown[]) => cards,
  EMPTY_FILTERS: { assignees: [], priorities: [], labels: [] },
}))
vi.mock('@/components/board/CardModal', () => ({
  CardModal: ({ cardId, onClose }: { cardId: string | null; onClose: () => void }) =>
    cardId ? (
      <div data-testid="card-modal">
        <span>{cardId}</span>
        <button onClick={onClose}>close</button>
      </div>
    ) : null,
}))

beforeEach(() => {
  vi.clearAllMocks()
  routeState.boardId = 'board-1'
  searchParamsState.value = ''
  boardState.board = { id: 'board-1', name: 'Test Board' }
  boardState.columns = [{ id: 'col-1', cards: [{ id: 'card-1' }, { id: 'card-2' }] }]
  boardState.isLoading = false
})

describe('Board page — card deep link', () => {
  it('POSITIVE: opens the card modal when ?card= matches a card on the loaded board', async () => {
    searchParamsState.value = 'card=card-1'
    const Page = (await import('../../src/app/(app)/board/[boardId]/page')).default
    render(<Page />)

    expect(await screen.findByTestId('card-modal')).toHaveTextContent('card-1')
  })

  it('NEGATIVE: ignores an unknown card id silently — no modal, no error', async () => {
    searchParamsState.value = 'card=does-not-exist'
    const Page = (await import('../../src/app/(app)/board/[boardId]/page')).default
    render(<Page />)

    await waitFor(() => expect(screen.queryByTestId('card-modal')).not.toBeInTheDocument())
  })

  it('EDGE: no ?card= param at all leaves the modal closed', async () => {
    const Page = (await import('../../src/app/(app)/board/[boardId]/page')).default
    render(<Page />)

    await waitFor(() => expect(screen.queryByTestId('card-modal')).not.toBeInTheDocument())
  })

  it('clears the ?card= param via router.replace (no push) when the modal closes', async () => {
    searchParamsState.value = 'card=card-1'
    const Page = (await import('../../src/app/(app)/board/[boardId]/page')).default
    render(<Page />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'close' }))

    expect(router.replace).toHaveBeenCalledWith('/board/board-1')
    expect(router.push).not.toHaveBeenCalled()
    expect(screen.queryByTestId('card-modal')).not.toBeInTheDocument()
  })

  it('EDGE: waits for the board to finish loading before applying the deep link', async () => {
    searchParamsState.value = 'card=card-1'
    boardState.isLoading = true
    boardState.board = null
    boardState.columns = []
    const Page = (await import('../../src/app/(app)/board/[boardId]/page')).default
    const { rerender } = render(<Page />)

    expect(screen.queryByTestId('card-modal')).not.toBeInTheDocument()
    expect(screen.getByText(/loading board/)).toBeInTheDocument()

    boardState.isLoading = false
    boardState.board = { id: 'board-1', name: 'Test Board' }
    boardState.columns = [{ id: 'col-1', cards: [{ id: 'card-1' }, { id: 'card-2' }] }]
    rerender(<Page />)

    await waitFor(() => expect(screen.getByTestId('card-modal')).toHaveTextContent('card-1'))
  })

  it('IMPORTANT: resets the deep-link latch when boardId changes, so a cross-board navigation still opens the new ?card=', async () => {
    searchParamsState.value = 'card=card-1'
    const Page = (await import('../../src/app/(app)/board/[boardId]/page')).default
    const { rerender } = render(<Page />)

    expect(await screen.findByTestId('card-modal')).toHaveTextContent('card-1')

    // App Router preserves this component instance across a param-only navigation
    // to a different board — simulate switching boards, each carrying its own ?card=.
    routeState.boardId = 'board-2'
    searchParamsState.value = 'card=card-9'
    boardState.board = { id: 'board-2', name: 'Other Board' }
    boardState.columns = [{ id: 'col-9', cards: [{ id: 'card-9' }] }]
    rerender(<Page />)

    await waitFor(() => expect(screen.getByTestId('card-modal')).toHaveTextContent('card-9'))
  })
})
