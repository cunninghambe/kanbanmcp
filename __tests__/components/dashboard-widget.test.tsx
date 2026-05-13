// @vitest-environment jsdom
/**
 * Tests for AssignmentWidget component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('swr', () => ({
  default: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/dashboard',
}))

import useSWR from 'swr'
import { AssignmentWidget } from '../../src/components/dashboard/AssignmentWidget'
import { mockSWR } from './_helpers/mock-swr'

const mockUseSWR = vi.mocked(useSWR)

const emptyData = { asAssignee: [], asReviewer: [], asApprover: [], overdue: [] }

const card = (id: string) => ({
  id,
  title: `Card ${id}`,
  boardId: 'board-1',
  boardName: 'Test Board',
  columnName: 'In Progress',
  priority: 'medium',
  dueDate: null,
  hasOpenReviews: false,
})

describe('AssignmentWidget', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows loading state', () => {
    mockUseSWR.mockReturnValue(mockSWR({ isLoading: true, data: undefined }))
    render(<AssignmentWidget onCardClick={vi.fn()} />)
    expect(screen.getByLabelText(/loading assignments/i)).toBeInTheDocument()
  })

  it('shows error state', () => {
    mockUseSWR.mockReturnValue(mockSWR({ error: new Error('fail'), data: undefined }))
    render(<AssignmentWidget onCardClick={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/failed to load/i)).toBeInTheDocument()
  })

  it('renders three section headings when data loads', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: emptyData }))
    render(<AssignmentWidget onCardClick={vi.fn()} />)
    expect(screen.getByText(/Needs your action/i)).toBeInTheDocument()
    expect(screen.getByText(/Assigned to you/i)).toBeInTheDocument()
    expect(screen.getByText(/Overdue/i)).toBeInTheDocument()
  })

  it('shows "Nothing here" when sections are empty', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: emptyData }))
    render(<AssignmentWidget onCardClick={vi.fn()} />)
    const emptyMessages = screen.getAllByText('Nothing here')
    expect(emptyMessages.length).toBeGreaterThanOrEqual(3)
  })

  it('renders asAssignee cards in "Assigned to you" section', () => {
    const data = { ...emptyData, asAssignee: [card('a1')] }
    mockUseSWR.mockReturnValue(mockSWR({ data }))
    render(<AssignmentWidget onCardClick={vi.fn()} />)
    expect(screen.getByText('Card a1')).toBeInTheDocument()
  })

  it('renders asReviewer and asApprover cards under "Needs your action"', () => {
    const data = {
      ...emptyData,
      asReviewer: [card('r1')],
      asApprover: [card('p1')],
    }
    mockUseSWR.mockReturnValue(mockSWR({ data }))
    render(<AssignmentWidget onCardClick={vi.fn()} />)
    expect(screen.getByText('Card r1')).toBeInTheDocument()
    expect(screen.getByText('Card p1')).toBeInTheDocument()
  })

  it('renders overdue cards under "Overdue"', () => {
    const overdueCard = { ...card('o1'), dueDate: '2020-01-01T00:00:00.000Z' }
    const data = { ...emptyData, overdue: [overdueCard] }
    mockUseSWR.mockReturnValue(mockSWR({ data }))
    render(<AssignmentWidget onCardClick={vi.fn()} />)
    expect(screen.getByText('Card o1')).toBeInTheDocument()
  })

  it('calls onCardClick with boardId and cardId when a card is clicked', async () => {
    const user = userEvent.setup()
    const onCardClick = vi.fn()
    const data = { ...emptyData, asAssignee: [card('click-me')] }
    mockUseSWR.mockReturnValue(mockSWR({ data }))
    render(<AssignmentWidget onCardClick={onCardClick} />)

    await user.click(screen.getByText('Card click-me'))
    expect(onCardClick).toHaveBeenCalledWith('board-1', 'click-me')
  })

  it('shows section badge counts', () => {
    const data = {
      asAssignee: [card('a1'), card('a2')],
      asReviewer: [card('r1')],
      asApprover: [],
      overdue: [card('o1')],
    }
    mockUseSWR.mockReturnValue(mockSWR({ data }))
    render(<AssignmentWidget onCardClick={vi.fn()} />)
    // Section count badges — get all and verify specific values exist
    const badges = document.querySelectorAll(
      'span.bg-slate-100'
    )
    const badgeTexts = Array.from(badges).map((b) => b.textContent)
    // "Needs your action" = 1 (r1), "Assigned to you" = 2, "Overdue" = 1
    expect(badgeTexts).toContain('2')
    expect(badgeTexts.filter((t) => t === '1').length).toBeGreaterThanOrEqual(1)
  })

  it('collapses a section when header button is clicked', async () => {
    const user = userEvent.setup()
    const data = { ...emptyData, asAssignee: [card('c1')] }
    mockUseSWR.mockReturnValue(mockSWR({ data }))
    render(<AssignmentWidget onCardClick={vi.fn()} />)

    // Card is visible initially
    expect(screen.getByText('Card c1')).toBeInTheDocument()

    // Click section toggle — find it by aria-expanded
    const toggles = screen.getAllByRole('button', { expanded: true })
    // Click "Assigned to you" toggle (second expanded button if all open)
    const assignedToggle = toggles.find((b) => b.textContent?.includes('Assigned to you'))
    expect(assignedToggle).toBeDefined()
    await user.click(assignedToggle!)

    expect(screen.queryByText('Card c1')).not.toBeInTheDocument()
  })
})
