// @vitest-environment jsdom
/**
 * Tests for SubcardTree component — M1.09
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('swr', () => ({
  default: vi.fn(),
}))

import useSWR from 'swr'
import { SubcardTree } from '../../src/components/board/SubcardTree'
import { mockSWR } from './_helpers/mock-swr'
import type { SubtreeNode } from '../../src/lib/tree'

const mockUseSWR = vi.mocked(useSWR)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<SubtreeNode> & { id: string; title: string }): SubtreeNode {
  return {
    id: overrides.id,
    title: overrides.title,
    description: null,
    parentCardId: overrides.parentCardId ?? null,
    path: overrides.path ?? '',
    depth: overrides.depth ?? 0,
    aiAutoReview: overrides.aiAutoReview ?? false,
    assigneeId: overrides.assigneeId ?? null,
    reviewerId: overrides.reviewerId ?? null,
    approverId: overrides.approverId ?? null,
    assignee: overrides.assignee ?? null,
    reviewer: overrides.reviewer ?? null,
    approver: overrides.approver ?? null,
    aiReviewParams: overrides.aiReviewParams ?? null,
    signoffs: overrides.signoffs ?? { reviewer: null, approver: null },
  }
}

const root = makeNode({
  id: 'card-root',
  title: 'Root card',
  depth: 0,
  path: '',
})

const child1 = makeNode({
  id: 'card-child-1',
  title: 'Child one',
  parentCardId: 'card-root',
  depth: 1,
  path: '/card-root/',
  assignee: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
})

const child2 = makeNode({
  id: 'card-child-2',
  title: 'Child two',
  parentCardId: 'card-root',
  depth: 1,
  path: '/card-root/',
})

const grandchild = makeNode({
  id: 'card-gc',
  title: 'Grandchild',
  parentCardId: 'card-child-1',
  depth: 2,
  path: '/card-root/card-child-1/',
})

// depth 3 relative = absolute depth 3 when root is 0
const deepChild = makeNode({
  id: 'card-deep',
  title: 'Deep child',
  parentCardId: 'card-gc',
  depth: 3,
  path: '/card-root/card-child-1/card-gc/',
})

function setupMock(
  data: { root: SubtreeNode; descendants: SubtreeNode[]; truncated: boolean } | undefined,
  opts?: { isLoading?: boolean; error?: Error }
) {
  mockUseSWR.mockReturnValue(
    mockSWR({
      data,
      isLoading: opts?.isLoading ?? false,
      error: opts?.error,
      mutate: vi.fn().mockResolvedValue(undefined),
    })
  )
}

const defaultOnOpenCard = vi.fn()

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubcardTree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ card: root }),
    })
  })

  // ---- Loading state -------------------------------------------------------

  it('renders loading skeleton when SWR is loading', () => {
    setupMock(undefined, { isLoading: true })

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Sub-cards')
    expect(screen.getByLabelText('Loading sub-cards')).toBeInTheDocument()
  })

  // ---- Error state ---------------------------------------------------------

  it('renders error state with retry button on fetch failure', () => {
    setupMock(undefined, { error: new Error('Network error') })

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    expect(screen.getByText(/Couldn't load sub-cards/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
  })

  it('calls refresh when Retry is clicked', async () => {
    const mutateFn = vi.fn().mockResolvedValue(undefined)
    mockUseSWR.mockReturnValue(
      mockSWR({
        data: undefined,
        isLoading: false,
        error: new Error('fail'),
        mutate: mutateFn,
      })
    )

    const user = userEvent.setup()
    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    await user.click(screen.getByRole('button', { name: /Retry/i }))
    expect(mutateFn).toHaveBeenCalled()
  })

  // ---- Empty state ---------------------------------------------------------

  it('renders empty state when descendants is empty', () => {
    setupMock({ root, descendants: [], truncated: false })

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    expect(screen.getByText(/No sub-cards yet/i)).toBeInTheDocument()
  })

  // ---- Tree rendering (flat-to-tree grouping) ------------------------------

  it('renders descendants grouped correctly under their parents', () => {
    setupMock({
      root,
      descendants: [child1, child2, grandchild],
      truncated: false,
    })

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    // Direct children of root are visible
    expect(screen.getByText('Child one')).toBeInTheDocument()
    expect(screen.getByText('Child two')).toBeInTheDocument()
    // Grandchild visible because relDepth=2 < COLLAPSE_FROM_DEPTH=3
    expect(screen.getByText('Grandchild')).toBeInTheDocument()
  })

  it('shows assignee avatar initial when assignee is present', () => {
    setupMock({
      root,
      descendants: [child1],
      truncated: false,
    })

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    // Avatar rendered as a span with the initial character (aria-hidden, titled)
    const avatar = document.querySelector('[title="Alice"]')
    expect(avatar).toBeInTheDocument()
    expect(avatar).toHaveTextContent('A')
  })

  // ---- Depth-3 collapse + expand ------------------------------------------

  it('renders depth-3 node visible but its children collapsed by default', () => {
    // deepChild is at absolute depth 3 = relative depth 3 from root (depth 0).
    // Per spec: depth 1–3 nodes are visible; depth ≥4 are hidden.
    // deepChild at relDepth=3 IS shown; its own children would be hidden.
    const depth4child = makeNode({
      id: 'card-d4',
      title: 'Fourth level child',
      parentCardId: 'card-deep',
      depth: 4,
      path: '/card-root/card-child-1/card-gc/card-deep/',
    })

    setupMock({
      root,
      descendants: [child1, grandchild, deepChild, depth4child],
      truncated: false,
    })

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    // depth-3 node IS rendered (its row is visible)
    expect(screen.getByText('Deep child')).toBeInTheDocument()
    // depth-4 node is NOT visible because deepChild (relDepth=3) starts collapsed
    expect(screen.queryByText('Fourth level child')).not.toBeInTheDocument()
  })

  it('expanding a depth-2 node with depth-3 children shows the depth-3 row', () => {
    // grandchild is at relDepth=2 (starts expanded).
    // deepChild is at relDepth=3 (also rendered as a row per spec "depth 3 is visible").
    setupMock({
      root,
      descendants: [child1, grandchild, deepChild],
      truncated: false,
    })

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    // Both grandchild (relDepth=2) and deepChild (relDepth=3) should be in the DOM
    expect(screen.getByText('Grandchild')).toBeInTheDocument()
    expect(screen.getByText('Deep child')).toBeInTheDocument()
  })

  it('manually collapsing a shallow node hides its descendants', async () => {
    setupMock({
      root,
      descendants: [child1, grandchild],
      truncated: false,
    })

    const user = userEvent.setup()
    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    // child1 starts expanded; grandchild is visible
    expect(screen.getByText('Grandchild')).toBeInTheDocument()

    // Collapse child1 by clicking the chevron
    const collapseBtn = screen.getByRole('button', {
      name: /Collapse sub-cards of Child one/i,
    })
    await user.click(collapseBtn)

    expect(screen.queryByText('Grandchild')).not.toBeInTheDocument()
  })

  it('manually expanding a collapsed node shows its children', async () => {
    setupMock({
      root,
      descendants: [child1, grandchild],
      truncated: false,
    })

    const user = userEvent.setup()
    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    // Collapse child1 first
    const collapseBtn = screen.getByRole('button', {
      name: /Collapse sub-cards of Child one/i,
    })
    await user.click(collapseBtn)
    expect(screen.queryByText('Grandchild')).not.toBeInTheDocument()

    // Expand again
    const expandBtn = screen.getByRole('button', {
      name: /Expand sub-cards of Child one/i,
    })
    await user.click(expandBtn)
    expect(screen.getByText('Grandchild')).toBeInTheDocument()
  })

  // ---- Opening a sub-card --------------------------------------------------

  it('calls onOpenCard when a sub-card title is clicked', async () => {
    setupMock({ root, descendants: [child1], truncated: false })
    const onOpenCard = vi.fn()
    const user = userEvent.setup()

    render(
      <SubcardTree cardId="card-root" boardId="board-1" columnId="col-1" onOpenCard={onOpenCard} />
    )

    await user.click(screen.getByRole('button', { name: 'Child one' }))
    expect(onOpenCard).toHaveBeenCalledWith('card-child-1')
  })

  // ---- Promote action — dialog-based confirmation -------------------------

  it('opens promote confirm dialog when Promote menu item is clicked', async () => {
    setupMock({ root, descendants: [child1], truncated: false })
    const user = userEvent.setup()

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    const actionBtn = screen.getByRole('button', {
      name: /Actions for Child one/i,
    })
    await user.click(actionBtn)
    await user.click(screen.getByRole('menuitem', { name: /Promote to top-level/i }))

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('heading', { name: /Promote to top-level card/i })).toBeInTheDocument()
  })

  it('shows promote confirm dialog and calls promote endpoint on confirm', async () => {
    setupMock({ root, descendants: [child1], truncated: false })
    const user = userEvent.setup()
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ card: child1 }),
    } as Response)

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    const actionBtn = screen.getByRole('button', {
      name: /Actions for Child one/i,
    })
    await user.click(actionBtn)
    await user.click(screen.getByRole('menuitem', { name: /Promote to top-level/i }))

    // Confirm via Promote button in dialog
    await user.click(screen.getByRole('button', { name: /^Promote$/i }))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/cards/card-child-1/promote',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  it('does NOT call promote endpoint when dialog Cancel is clicked', async () => {
    setupMock({ root, descendants: [child1], truncated: false })
    const user = userEvent.setup()

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    const actionBtn = screen.getByRole('button', {
      name: /Actions for Child one/i,
    })
    await user.click(actionBtn)
    await user.click(screen.getByRole('menuitem', { name: /Promote to top-level/i }))

    // Cancel via Cancel button in dialog
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/promote'),
      expect.anything()
    )
  })

  it('closes promote dialog when Escape is pressed', async () => {
    setupMock({ root, descendants: [child1], truncated: false })
    const user = userEvent.setup()

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    const actionBtn = screen.getByRole('button', {
      name: /Actions for Child one/i,
    })
    await user.click(actionBtn)
    await user.click(screen.getByRole('menuitem', { name: /Promote to top-level/i }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/promote'),
      expect.anything()
    )
  })

  it('shows inline error when promote API call fails', async () => {
    setupMock({ root, descendants: [child1], truncated: false })
    const user = userEvent.setup()
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Promote failed.' }),
    } as Response)

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    const actionBtn = screen.getByRole('button', {
      name: /Actions for Child one/i,
    })
    await user.click(actionBtn)
    await user.click(screen.getByRole('menuitem', { name: /Promote to top-level/i }))
    await user.click(screen.getByRole('button', { name: /^Promote$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Promote failed/i)
    })
  })

  // ---- Add sub-card --------------------------------------------------------

  it('shows add sub-card form when button is clicked', async () => {
    setupMock({ root, descendants: [], truncated: false })
    const user = userEvent.setup()

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    await user.click(screen.getByRole('button', { name: /\+ Add sub-card/i }))
    expect(screen.getByRole('textbox', { name: /Sub-card title/i })).toBeInTheDocument()
  })

  it('calls POST /api/boards/[boardId]/cards when add sub-card form is submitted', async () => {
    setupMock({ root, descendants: [], truncated: false })
    const user = userEvent.setup()
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ card: child1 }),
    } as Response)

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    await user.click(screen.getByRole('button', { name: /\+ Add sub-card/i }))

    const titleInput = screen.getByRole('textbox', {
      name: /Sub-card title/i,
    })
    await user.type(titleInput, 'New sub-card')
    await user.click(screen.getByRole('button', { name: /^Add$/i }))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/boards/board-1/cards',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('New sub-card'),
        })
      )
    })
  })

  it('sends correct columnId in add sub-card POST body', async () => {
    setupMock({ root, descendants: [], truncated: false })
    const user = userEvent.setup()
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ card: child1 }),
    } as Response)

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-correct"
        onOpenCard={defaultOnOpenCard}
      />
    )

    await user.click(screen.getByRole('button', { name: /\+ Add sub-card/i }))
    await user.type(screen.getByRole('textbox', { name: /Sub-card title/i }), 'A sub-card')
    await user.click(screen.getByRole('button', { name: /^Add$/i }))

    await waitFor(() => {
      const call = vi
        .mocked(global.fetch)
        .mock.calls.find((c) => (c[0] as string).includes('/api/boards/board-1/cards'))
      expect(call).toBeDefined()
      const body = JSON.parse(call![1]!.body as string) as Record<string, unknown>
      expect(body.columnId).toBe('col-correct')
    })
  })

  it('shows inline error when add sub-card API call fails', async () => {
    setupMock({ root, descendants: [], truncated: false })
    const user = userEvent.setup()
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'assigneeId is required' }),
    } as Response)

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    await user.click(screen.getByRole('button', { name: /\+ Add sub-card/i }))
    const titleInput = screen.getByRole('textbox', { name: /Sub-card title/i })
    await user.type(titleInput, 'Broken sub-card')
    await user.click(screen.getByRole('button', { name: /^Add$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/assigneeId/i)
    })
  })

  // ---- Keyboard navigation -------------------------------------------------

  it('Tab + Enter on chevron toggles expansion', async () => {
    setupMock({ root, descendants: [child1, grandchild], truncated: false })
    const user = userEvent.setup()

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    // grandchild is visible because child1 (depth 1) starts expanded
    expect(screen.getByText('Grandchild')).toBeInTheDocument()

    // Focus the collapse button for child1 via keyboard
    const collapseBtn = screen.getByRole('button', {
      name: /Collapse sub-cards of Child one/i,
    })
    collapseBtn.focus()
    await user.keyboard('{Enter}')

    expect(screen.queryByText('Grandchild')).not.toBeInTheDocument()
  })

  // ---- SubcardTree heading in CardDetailSections order --------------------

  it('renders Sub-cards section heading', () => {
    setupMock({ root, descendants: [], truncated: false })

    render(
      <SubcardTree
        cardId="card-root"
        boardId="board-1"
        columnId="col-1"
        onOpenCard={defaultOnOpenCard}
      />
    )

    expect(screen.getByRole('heading', { level: 3, name: /Sub-cards/i })).toBeInTheDocument()
  })
})
