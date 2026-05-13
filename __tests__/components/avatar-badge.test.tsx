// @vitest-environment jsdom
/**
 * Tests for avatar badge in Sidebar component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('swr', () => ({
  default: vi.fn(),
}))

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('../../src/hooks/useSession', () => ({
  useSession: vi.fn(),
}))

import useSWR from 'swr'
import { useSession } from '../../src/hooks/useSession'
import { Sidebar } from '../../src/components/layout/Sidebar'
import { mockSWR } from './_helpers/mock-swr'

const mockUseSWR = vi.mocked(useSWR)
const mockUseSession = vi.mocked(useSession)

const testUser = { id: 'u1', name: 'Alice', email: 'alice@example.com' }
const testOrg = { id: 'org-1', name: 'Test Org', slug: 'test' }

function setupSWR(assignmentCounts?: {
  asAssignee: unknown[]
  asReviewer: unknown[]
  asApprover: unknown[]
  overdue: unknown[]
}) {
  mockUseSWR.mockImplementation((key) => {
    if (typeof key === 'string' && key.includes('/api/orgs/')) {
      return mockSWR({ data: [] })
    }
    if (key === '/api/me/assignments') {
      return mockSWR({
        data: assignmentCounts ?? { asAssignee: [], asReviewer: [], asApprover: [], overdue: [] },
      })
    }
    return mockSWR({ data: null })
  })
}

describe('Sidebar avatar badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSession.mockReturnValue({
      user: testUser,
      org: testOrg,
      orgMemberships: [],
      isLoading: false,
      isError: false,
      mutate: vi.fn(),
    })
  })

  it('hides badge when assignment count is 0', () => {
    setupSWR({ asAssignee: [], asReviewer: [], asApprover: [], overdue: [] })
    render(<Sidebar />)
    // Badge span should not exist
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it('shows badge with correct count when assignments exist', () => {
    setupSWR({
      asAssignee: [{ id: 'c1' }],
      asReviewer: [{ id: 'c2' }],
      asApprover: [],
      overdue: [{ id: 'c3' }],
    })
    render(<Sidebar />)
    // Total = 1 + 1 + 0 + 1 = 3
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('shows tooltip text on the avatar link', () => {
    setupSWR({
      asAssignee: [{ id: 'c1' }],
      asReviewer: [],
      asApprover: [],
      overdue: [],
    })
    render(<Sidebar />)
    const avatarLink = screen.getByRole('link', { name: /items need your attention/i })
    expect(avatarLink).toBeInTheDocument()
  })

  it('avatar link navigates to /dashboard', async () => {
    setupSWR({ asAssignee: [{ id: 'c1' }], asReviewer: [], asApprover: [], overdue: [] })
    render(<Sidebar />)
    const avatarLink = screen.getByRole('link', { name: /items need your attention/i })
    expect(avatarLink).toHaveAttribute('href', '/dashboard')
  })

  it('caps badge at 99+ when count exceeds 99', () => {
    const manyCards = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}` }))
    setupSWR({
      asAssignee: manyCards,
      asReviewer: manyCards,
      asApprover: manyCards,
      overdue: manyCards,
    })
    render(<Sidebar />)
    expect(screen.getByText('99+')).toBeInTheDocument()
  })

  it('does not render badge when no data loaded yet', () => {
    mockUseSWR.mockImplementation((key) => {
      if (key === '/api/me/assignments') return mockSWR({ data: undefined })
      return mockSWR({ data: [] })
    })
    render(<Sidebar />)
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument()
    expect(screen.queryByText('99+')).not.toBeInTheDocument()
  })
})
