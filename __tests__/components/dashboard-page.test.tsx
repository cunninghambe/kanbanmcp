// @vitest-environment jsdom
/**
 * Tests for the dashboard's queue-row navigation. A row click must route to
 * the card's actual board (via `boardId`, deep-linked with `?card=`), not to
 * `/board/<cardId>` — which 404s because the card id is not a board id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

const router = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}))

const assignmentsState = vi.hoisted(() => ({
  data: {
    asAssignee: [] as unknown[],
    asReviewer: [] as unknown[],
    asApprover: [] as unknown[],
    overdue: [] as unknown[],
  },
  isLoading: false,
  error: undefined as Error | undefined,
}))

vi.mock('@/components/dashboard/AssignmentWidget', () => ({
  useAssignments: () => assignmentsState,
}))

vi.mock('swr', () => ({
  default: () => ({ data: undefined, error: undefined, isLoading: false }),
}))

const card = (id: string, boardId: string, title: string) => ({
  id,
  title,
  boardId,
  boardName: 'Some Board',
  columnName: 'Backlog',
  priority: 'medium',
  dueDate: null,
  hasOpenReviews: false,
})

describe('Dashboard page — queue row navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    assignmentsState.data = { asAssignee: [], asReviewer: [], asApprover: [], overdue: [] }
    assignmentsState.isLoading = false
    assignmentsState.error = undefined
  })

  it('routes an "assigned to you" row to the card\'s real board, not to a board named after the card', async () => {
    assignmentsState.data.asAssignee = [card('card-xyz123', 'board-abc456', 'Fix the thing')]
    const Page = (await import('../../src/app/(app)/dashboard/page')).default
    const user = userEvent.setup()
    render(<Page />)

    await user.click(await screen.findByRole('listitem', { name: /Fix the thing/i }))

    expect(router.push).toHaveBeenCalledWith('/board/board-abc456?card=card-xyz123')
  })

  it('routes a "needs you · reviewer" row using its own boardId', async () => {
    assignmentsState.data.asReviewer = [card('card-r1', 'board-r-owner', 'Review this')]
    const Page = (await import('../../src/app/(app)/dashboard/page')).default
    const user = userEvent.setup()
    render(<Page />)

    await user.click(await screen.findByRole('listitem', { name: /Review this/i }))

    expect(router.push).toHaveBeenCalledWith('/board/board-r-owner?card=card-r1')
  })

  it('routes an overdue row (spread from toQueueRow) using its boardId', async () => {
    assignmentsState.data.overdue = [card('card-late', 'board-late-owner', 'Overdue thing')]
    const Page = (await import('../../src/app/(app)/dashboard/page')).default
    const user = userEvent.setup()
    render(<Page />)

    await user.click(await screen.findByRole('listitem', { name: /Overdue thing/i }))

    expect(router.push).toHaveBeenCalledWith('/board/board-late-owner?card=card-late')
  })
})
