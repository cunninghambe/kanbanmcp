// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('swr', () => ({
  default: vi.fn(),
}))
vi.mock('@/components/design/Chip', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

import useSWR from 'swr'
import ChangesIndexPage from '../../src/app/(app)/changes/page'
import { mockSWR } from './_helpers/mock-swr'

const mockUseSWR = vi.mocked(useSWR)

type ChangeSetSummary = {
  id: string
  status: string
  summary: string | null
  hudSessionId: string | null
  hudSessionTitle: string | null
  itemCount: number
  createdAt: string
}

function changeSet(overrides: Partial<ChangeSetSummary> = {}): ChangeSetSummary {
  return {
    id: 'cs-1',
    status: 'pending',
    summary: 'Move 3 cards to Done',
    hudSessionId: 'hud-1',
    hudSessionTitle: 'Weekly sync',
    itemCount: 3,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  }
}

function lastSWRKey(): string {
  const calls = mockUseSWR.mock.calls
  return calls[calls.length - 1][0] as string
}

describe('ChangesIndexPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSWR.mockReturnValue(mockSWR({ data: { changeSets: [] } }))
  })

  it('defaults to fetching status=pending', () => {
    render(<ChangesIndexPage />)
    expect(lastSWRKey()).toBe('/api/changesets?status=pending')
  })

  it('re-fetches with the matching status param when a filter chip is clicked', async () => {
    const user = userEvent.setup()
    render(<ChangesIndexPage />)

    await user.click(screen.getByRole('tab', { name: 'applied' }))
    expect(lastSWRKey()).toBe('/api/changesets?status=applied')

    await user.click(screen.getByRole('tab', { name: 'rejected' }))
    expect(lastSWRKey()).toBe('/api/changesets?status=rejected')

    await user.click(screen.getByRole('tab', { name: 'expired' }))
    expect(lastSWRKey()).toBe('/api/changesets?status=expired')
  })

  it('fetches with no status param when "all" is selected', async () => {
    const user = userEvent.setup()
    render(<ChangesIndexPage />)

    await user.click(screen.getByRole('tab', { name: 'all' }))
    expect(lastSWRKey()).toBe('/api/changesets')
  })

  it('marks the active filter tab as selected', async () => {
    const user = userEvent.setup()
    render(<ChangesIndexPage />)

    expect(screen.getByRole('tab', { name: 'pending' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('tab', { name: 'applied' }))
    expect(screen.getByRole('tab', { name: 'applied' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'pending' })).toHaveAttribute('aria-selected', 'false')
  })

  it('renders a row linking to /changes/<id>', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: { changeSets: [changeSet()] } }))
    render(<ChangesIndexPage />)

    const rowLink = screen.getAllByRole('link').find((l) => l.getAttribute('href') === '/changes/cs-1')
    expect(rowLink).toBeDefined()
    expect(rowLink).toHaveTextContent('Move 3 cards to Done')
  })

  it('shows "(no summary)" when summary is null', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: { changeSets: [changeSet({ summary: null })] } }))
    render(<ChangesIndexPage />)
    expect(screen.getByText('(no summary)')).toBeInTheDocument()
  })

  it('renders a link to the origin HUD session when hudSessionTitle is present', () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: { changeSets: [changeSet()] } }))
    render(<ChangesIndexPage />)

    const hudLink = screen.getByRole('link', { name: 'Weekly sync' })
    expect(hudLink).toHaveAttribute('href', '/hud/hud-1')
  })

  it('does not render an origin HUD link when hudSessionId is absent', () => {
    mockUseSWR.mockReturnValue(
      mockSWR({ data: { changeSets: [changeSet({ hudSessionId: null, hudSessionTitle: null })] } })
    )
    render(<ChangesIndexPage />)
    expect(screen.queryByRole('link', { name: 'Weekly sync' })).not.toBeInTheDocument()
  })

  it('shows an empty state when there are no change sets', () => {
    render(<ChangesIndexPage />)
    expect(screen.getByText('no change sets')).toBeInTheDocument()
  })
})
