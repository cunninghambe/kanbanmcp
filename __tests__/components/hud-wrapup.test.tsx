// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { WrapUp } from '../../src/app/(app)/hud/_components/WrapUp'

vi.mock('../../src/app/(app)/hud/hud.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}))
vi.mock('@/components/design/Chip', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

const { digestFixture, changeSetsFixture } = vi.hoisted(() => {
  const digestFixture = {
    stats: {
      durationMs: 1_800_000,
      dispatches: 3,
      answered: 2,
      failed: 1,
      proposals: 2,
      proposalsPending: 1,
      actions: 4,
      actionsWithCards: 1,
      decisions: 5,
      notes: 1,
      agendaDone: 2,
      agendaTotal: 6,
    },
    agenda: [],
    decisions: [],
    notes: [],
    actions: [],
    dispatches: [
      { target: 'board', question: 'Which cards moved?', status: 'done', answerExcerpt: 'Card A moved to Done.' },
      { target: 'drive', question: 'Any new docs?', status: 'failed', answerExcerpt: null },
    ],
    changeSets: [],
    markdown: '# Weekly sync — meeting digest\n**When:** Jul 13 → Jul 13 (0:30)',
  }
  const changeSetsFixture = [
    {
      id: 'cs-pending',
      status: 'pending',
      summary: 'Move 3 cards to Done',
      boardId: 'b1',
      hudSessionId: 's1',
      dispatchId: null,
      itemCount: 3,
      hudSessionTitle: 'Weekly sync',
      createdById: 'u1',
      createdAt: '2026-07-13T10:00:00.000Z',
    },
    {
      id: 'cs-applied',
      status: 'applied',
      summary: 'Update priority',
      boardId: 'b1',
      hudSessionId: 's1',
      dispatchId: null,
      itemCount: 1,
      hudSessionTitle: 'Weekly sync',
      createdById: 'u1',
      createdAt: '2026-07-13T09:00:00.000Z',
    },
  ]
  return { digestFixture, changeSetsFixture }
})

vi.mock('swr', () => ({
  default: vi.fn((key: unknown) => {
    if (typeof key === 'string' && key.startsWith('/api/changesets')) {
      return { data: { changeSets: changeSetsFixture }, mutate: vi.fn() }
    }
    return { data: { digest: digestFixture }, mutate: vi.fn() }
  }),
}))

describe('WrapUp — stats', () => {
  it('renders stat tiles computed from the digest', async () => {
    render(<WrapUp sessionId="s1" />)

    expect(await screen.findByRole('group', { name: 'dispatches: 2 of 3 answered' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'actions: 1 of 4 converted to cards' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'decisions: 5' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'agenda: 2 of 6 done' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'proposals pending: 1' })).toBeInTheDocument()
  })
})

describe('WrapUp — pending proposals', () => {
  it('links pending proposals to /changes/<id> and excludes non-pending sets', async () => {
    render(<WrapUp sessionId="s1" />)

    const link = await screen.findByRole('link', { name: /Move 3 cards to Done/ })
    expect(link).toHaveAttribute('href', '/changes/cs-pending')
    expect(screen.queryByText(/Update priority/)).not.toBeInTheDocument()
  })
})

describe('WrapUp — dispatch history', () => {
  it('renders collapsed dispatch rows with target/question/status and no full answers', async () => {
    render(<WrapUp sessionId="s1" />)

    expect(await screen.findByText('Which cards moved?')).toBeInTheDocument()
    expect(screen.getByText('board')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.getByText('Any new docs?')).toBeInTheDocument()
    expect(screen.getByText('drive')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.queryByText('Card A moved to Done.')).not.toBeInTheDocument()
  })
})

describe('WrapUp — copy digest', () => {
  it('writes digest.markdown to the clipboard and flashes copied confirmation', async () => {
    // user-event installs its own navigator.clipboard stub during setup(), so the
    // mock must be defined after setup() to take effect.
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<WrapUp sessionId="s1" />)
    const button = await screen.findByRole('button', { name: 'copy digest' })
    await act(async () => {
      await user.click(button)
    })

    expect(writeText).toHaveBeenCalledWith(digestFixture.markdown)
    expect(screen.getByText('copied ✓')).toBeInTheDocument()
  })
})
