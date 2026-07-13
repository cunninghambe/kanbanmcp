// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('swr', () => ({
  default: vi.fn(),
}))

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

import useSWR from 'swr'
import { ChangeSetReview } from '../../src/components/changes/ChangeSetReview'
import { mockSWR } from './_helpers/mock-swr'

const mockUseSWR = vi.mocked(useSWR)

type ChangeItem = {
  id: string
  op: string
  payload: Record<string, unknown>
  display: string
  evidence: { quote?: string } | null
  confidence: number | null
  decision: string
  error: string | null
  appliedAt: string | null
}

function item(overrides: Partial<ChangeItem> = {}): ChangeItem {
  return {
    id: 'item-1',
    op: 'move_card',
    payload: { cardId: 'card-1', columnId: 'col-2' },
    display: 'Move "Fix login bug" from Backlog to In Progress',
    evidence: null,
    confidence: 0.9,
    decision: 'pending',
    error: null,
    appliedAt: null,
    ...overrides,
  }
}

function changeSet(overrides: {
  status?: string
  summary?: string | null
  items?: ChangeItem[]
} = {}) {
  return {
    changeSet: {
      id: 'cs-1',
      status: overrides.status ?? 'pending',
      summary: overrides.summary ?? 'Proposed board changes',
      boardId: 'board-1',
      createdById: 'user-1',
      items: overrides.items ?? [item()],
    },
  }
}

describe('ChangeSetReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the display sentence as the primary line for each item', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet() }))
    render(<ChangeSetReview changeSetId="cs-1" />)
    expect(screen.getByText('Move "Fix login bug" from Backlog to In Progress')).toBeInTheDocument()
  })

  it('renders the raw payload JSON inside a collapsed <details>', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet() }))
    render(<ChangeSetReview changeSetId="cs-1" />)

    const summary = screen.getByText('raw op')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details).not.toHaveAttribute('open')
    expect(screen.getByText(/"cardId": "card-1"/)).not.toBeVisible()
  })

  it('reveals the raw payload when the details summary is clicked', async () => {
    const user = userEvent.setup()
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet() }))
    render(<ChangeSetReview changeSetId="cs-1" />)

    await user.click(screen.getByText('raw op'))
    expect(screen.getByText(/"cardId": "card-1"/)).toBeVisible()
  })

  it('applies checked items via POST /apply with approvedItemIds', async () => {
    const user = userEvent.setup()
    const mutate = vi.fn()
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet(), mutate }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'applied', failures: 0 }) })
    )

    render(<ChangeSetReview changeSetId="cs-1" />)
    await user.click(screen.getByRole('checkbox', { name: /select:/i }))
    await user.click(screen.getByRole('button', { name: 'apply selected' }))

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/changesets/cs-1/apply',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ approvedItemIds: ['item-1'] }) })
    )
    expect(mutate).toHaveBeenCalled()
  })

  it('rejects checked items via POST /decisions with decision: rejected and revalidates', async () => {
    const user = userEvent.setup()
    const mutate = vi.fn()
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet(), mutate }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ changeSet: {} }) })
    )

    render(<ChangeSetReview changeSetId="cs-1" />)
    await user.click(screen.getByRole('checkbox', { name: /select:/i }))
    await user.click(screen.getByRole('button', { name: 'reject selected' }))

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/changesets/cs-1/decisions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decisions: [{ itemId: 'item-1', decision: 'rejected' }] }),
      })
    )
    expect(mutate).toHaveBeenCalled()
  })

  it('does not POST when no items are checked', async () => {
    const user = userEvent.setup()
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet() }))
    vi.stubGlobal('fetch', vi.fn())

    render(<ChangeSetReview changeSetId="cs-1" />)
    await user.click(screen.getByRole('button', { name: 'reject selected' }))

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('renders an expired status chip with no tone class (neutral)', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet({ status: 'expired' }) }))
    render(<ChangeSetReview changeSetId="cs-1" />)

    const chip = screen.getByText('expired')
    expect(chip.className.split(' ')).toEqual(['km-chip'])
  })

  it('renders a tone class for a non-neutral status (e.g. rejected)', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet({ status: 'rejected' }) }))
    render(<ChangeSetReview changeSetId="cs-1" />)

    const chip = screen.getByText('rejected')
    expect(chip.className).toContain('km-chip--err')
  })

  it('hides apply/reject controls and checkboxes once a set is no longer pending', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet({ status: 'applied', items: [item({ decision: 'approved' })] }) }))
    render(<ChangeSetReview changeSetId="cs-1" />)

    expect(screen.queryByRole('button', { name: 'apply selected' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'reject selected' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('does not show a checkbox for an already-decided item in a still-pending set', () => {
    mockUseSWR.mockReturnValue(
      mockSWR({
        data: changeSet({
          status: 'partially_applied',
          items: [item({ id: 'a', decision: 'approved' }), item({ id: 'b', decision: 'pending' })],
        }),
      })
    )
    render(<ChangeSetReview changeSetId="cs-1" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  })

  it('navigates to backHref (default /changes) when back is clicked', async () => {
    const user = userEvent.setup()
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet() }))
    render(<ChangeSetReview changeSetId="cs-1" />)

    await user.click(screen.getByRole('button', { name: 'back' }))
    expect(push).toHaveBeenCalledWith('/changes')
  })

  it('navigates to a custom backHref when provided', async () => {
    const user = userEvent.setup()
    mockUseSWR.mockReturnValue(mockSWR({ data: changeSet() }))
    render(<ChangeSetReview changeSetId="cs-1" backHref="/hud/h1" />)

    await user.click(screen.getByRole('button', { name: 'back' }))
    expect(push).toHaveBeenCalledWith('/hud/h1')
  })

  it('shows a loading state before data arrives', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: undefined }))
    render(<ChangeSetReview changeSetId="cs-1" />)
    expect(screen.getByText('loading…')).toBeInTheDocument()
  })
})
