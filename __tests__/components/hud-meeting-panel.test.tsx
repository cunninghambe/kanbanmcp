// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { MeetingPanel } from '../../src/app/(app)/hud/_components/MeetingPanel'
import type { Entry } from '../../src/app/(app)/hud/_components/MeetingPanel'

vi.mock('../../src/app/(app)/hud/hud.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}))
vi.mock('@/components/design/Chip', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

function agenda(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e-agenda-1',
    kind: 'agenda',
    text: 'Review roadmap',
    position: 1,
    checkedAt: null,
    assigneeId: null,
    assigneeName: null,
    dueDate: null,
    cardId: null,
    createdAt: '2026-07-13T10:00:00.000Z',
    ...overrides,
  }
}

function action(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e-action-1',
    kind: 'action',
    text: 'send contract',
    position: 0,
    checkedAt: null,
    assigneeId: null,
    assigneeName: null,
    dueDate: null,
    cardId: null,
    createdAt: '2026-07-13T10:05:00.000Z',
    ...overrides,
  }
}

function mockFetchOnce(response: { ok: boolean; status?: number; json: unknown }) {
  return vi.fn().mockResolvedValueOnce({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.json,
  })
}

describe('MeetingPanel — agenda', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders agenda entries ordered with checkboxes', () => {
    const entries = [agenda({ id: 'a1', text: 'First item', position: 1 }), agenda({ id: 'a2', text: 'Second item', position: 2 })]
    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={entries} onMutate={vi.fn()} />)

    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    expect(screen.getByRole('checkbox', { name: 'First item' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Second item' })).toBeInTheDocument()
  })

  it('checking an agenda item PATCHes { checked: true } and calls onMutate', async () => {
    const user = userEvent.setup()
    const onMutate = vi.fn()
    vi.stubGlobal('fetch', mockFetchOnce({ ok: true, json: { entry: agenda() } }))

    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[agenda({ checkedAt: null })]} onMutate={onMutate} />)
    await user.click(screen.getByRole('checkbox', { name: 'Review roadmap' }))

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/hud/entries/e-agenda-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ checked: true }) })
    )
    expect(onMutate).toHaveBeenCalled()
  })

  it('unchecking an agenda item PATCHes { checked: false }', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', mockFetchOnce({ ok: true, json: { entry: agenda() } }))

    render(
      <MeetingPanel
        sessionId="s1"
        live
        boardId="b1"
        entries={[agenda({ checkedAt: '2026-07-13T10:01:00.000Z' })]}
        onMutate={vi.fn()}
      />
    )
    await user.click(screen.getByRole('checkbox', { name: 'Review roadmap' }))

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/hud/entries/e-agenda-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ checked: false }) })
    )
  })

  it('agenda check-off stays enabled when live is false', () => {
    render(<MeetingPanel sessionId="s1" live={false} boardId="b1" entries={[agenda()]} onMutate={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'Review roadmap' })).not.toBeDisabled()
  })

  it('Enter in the add-agenda input POSTs kind agenda and clears the input', async () => {
    const user = userEvent.setup()
    const onMutate = vi.fn()
    vi.stubGlobal('fetch', mockFetchOnce({ ok: true, status: 201, json: { entry: agenda({ id: 'new' }) } }))

    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={onMutate} />)
    const input = screen.getByLabelText('Add agenda item')
    await user.type(input, 'New agenda item{Enter}')

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/hud/s1/entries',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'agenda', text: 'New agenda item' }) })
    )
    expect(onMutate).toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('agenda add input is disabled when live is false', () => {
    render(<MeetingPanel sessionId="s1" live={false} boardId="b1" entries={[]} onMutate={vi.fn()} />)
    expect(screen.getByLabelText('Add agenda item')).toBeDisabled()
  })
})

describe('MeetingPanel — capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaults to the action kind chip pressed', () => {
    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'action' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'note' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'decision' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking a kind chip switches the pressed state', async () => {
    const user = userEvent.setup()
    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'note' }))
    expect(screen.getByRole('button', { name: 'note' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'action' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows the token hint line for the action kind', () => {
    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={vi.fn()} />)
    expect(screen.getByText('@name due:fri · tokens parse to assignee/due')).toBeInTheDocument()
  })

  it('hides the token hint line for note/decision kinds', async () => {
    const user = userEvent.setup()
    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'note' }))
    expect(screen.queryByText('@name due:fri · tokens parse to assignee/due')).not.toBeInTheDocument()
  })

  it('Enter submits POST { kind, text } and clears the input', async () => {
    const user = userEvent.setup()
    const onMutate = vi.fn()
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({ ok: true, status: 201, json: { entry: action(), assigneeResolution: 'none' } })
    )

    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={onMutate} />)
    const input = screen.getByLabelText('Capture note, decision, or action')
    await user.type(input, 'send contract{Enter}')

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/hud/s1/entries',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'action', text: 'send contract' }) })
    )
    expect(onMutate).toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('renders candidate names when the response is ambiguous, and clicking one PATCHes assigneeId', async () => {
    const user = userEvent.setup()
    const onMutate = vi.fn()
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        entry: action({ id: 'e-ambig' }),
        assigneeResolution: 'ambiguous',
        candidates: [
          { id: 'u-brad', name: 'Brad' },
          { id: 'u-bradley', name: 'Bradley' },
        ],
      }),
    })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entry: action({ id: 'e-ambig' }) }) })
    vi.stubGlobal('fetch', fetchMock)

    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={onMutate} />)
    const input = screen.getByLabelText('Capture note, decision, or action')
    await user.type(input, '@brad call{Enter}')

    expect(await screen.findByRole('button', { name: 'Assign to Brad' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assign to Bradley' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Assign to Brad' }))

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/hud/entries/e-ambig',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ assigneeId: 'u-brad' }) })
    )
    expect(onMutate).toHaveBeenCalledTimes(2)
  })

  it('removes the candidates from the DOM after a successful pick', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        entry: action({ id: 'e-ambig' }),
        assigneeResolution: 'ambiguous',
        candidates: [{ id: 'u-brad', name: 'Brad' }],
      }),
    })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entry: action({ id: 'e-ambig' }) }) })
    vi.stubGlobal('fetch', fetchMock)

    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={vi.fn()} />)
    const input = screen.getByLabelText('Capture note, decision, or action')
    await user.type(input, '@brad call{Enter}')
    await screen.findByRole('button', { name: 'Assign to Brad' })

    await user.click(screen.getByRole('button', { name: 'Assign to Brad' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Assign to Brad' })).not.toBeInTheDocument())
  })

  it('keeps candidates mounted and shows an inline alert when the pick PATCH fails', async () => {
    const user = userEvent.setup()
    const onMutate = vi.fn()
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        entry: action({ id: 'e-ambig' }),
        assigneeResolution: 'ambiguous',
        candidates: [{ id: 'u-brad', name: 'Brad' }],
      }),
    })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'Assignment failed' }) })
    vi.stubGlobal('fetch', fetchMock)

    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={onMutate} />)
    const input = screen.getByLabelText('Capture note, decision, or action')
    await user.type(input, '@brad call{Enter}')
    await screen.findByRole('button', { name: 'Assign to Brad' })
    onMutate.mockClear()

    await user.click(screen.getByRole('button', { name: 'Assign to Brad' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Assignment failed')
    expect(screen.getByRole('button', { name: 'Assign to Brad' })).toBeInTheDocument()
    expect(onMutate).not.toHaveBeenCalled()
  })

  it('does not clear the capture input when the POST fails', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', mockFetchOnce({ ok: false, status: 500, json: { error: 'boom' } }))

    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={vi.fn()} />)
    const input = screen.getByLabelText('Capture note, decision, or action')
    await user.type(input, 'send contract{Enter}')

    expect(input).toHaveValue('send contract')
  })

  it('reports a network failure through the same inline-alert path as a non-2xx response', async () => {
    const user = userEvent.setup()
    const onMutate = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')))

    render(
      <MeetingPanel sessionId="s1" live boardId="b1" entries={[action({ id: 'e1', text: 'convertible' })]} onMutate={onMutate} />
    )
    await user.click(screen.getByRole('button', { name: 'Create card for "convertible"' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create card')
    expect(onMutate).not.toHaveBeenCalled()
  })

  it('groups the capture kind chips under an accessible group label', () => {
    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={[]} onMutate={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'capture kind' })).toBeInTheDocument()
  })

  it('disables kind chips and capture input when live is false', () => {
    render(<MeetingPanel sessionId="s1" live={false} boardId="b1" entries={[]} onMutate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'action' })).toBeDisabled()
    expect(screen.getByLabelText('Capture note, decision, or action')).toBeDisabled()
  })
})

describe('MeetingPanel — log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders notes/decisions/actions newest-first by createdAt', () => {
    const entries = [
      action({ id: 'e1', text: 'oldest', createdAt: '2026-07-13T09:00:00.000Z' }),
      { ...action({ id: 'e2', text: 'newest', createdAt: '2026-07-13T11:00:00.000Z' }), kind: 'note' as const },
      action({ id: 'e3', text: 'middle', createdAt: '2026-07-13T10:00:00.000Z' }),
    ]
    render(<MeetingPanel sessionId="s1" live boardId="b1" entries={entries} onMutate={vi.fn()} />)

    const rows = screen.getAllByText(/oldest|newest|middle/)
    expect(rows.map((r) => r.textContent)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('shows a "→ card" button only when boardId is set and the entry has no cardId', () => {
    render(
      <MeetingPanel
        sessionId="s1"
        live
        boardId="b1"
        entries={[action({ id: 'e1', text: 'convertible' })]}
        onMutate={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Create card for "convertible"' })).toBeInTheDocument()
  })

  it('does not show a "→ card" button when there is no board', () => {
    render(
      <MeetingPanel sessionId="s1" live boardId={null} entries={[action({ id: 'e1', text: 'no board' })]} onMutate={vi.fn()} />
    )
    expect(screen.queryByRole('button', { name: /Create card/ })).not.toBeInTheDocument()
  })

  it('shows a board link instead of "→ card" when cardId is already set', () => {
    render(
      <MeetingPanel
        sessionId="s1"
        live
        boardId="b1"
        entries={[action({ id: 'e1', text: 'converted', cardId: 'card-1' })]}
        onMutate={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /Create card/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /view card/ })).toHaveAttribute('href', '/board/b1')
  })

  it('"→ card" always stays enabled when live is false', () => {
    render(
      <MeetingPanel
        sessionId="s1"
        live={false}
        boardId="b1"
        entries={[action({ id: 'e1', text: 'convertible' })]}
        onMutate={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Create card for "convertible"' })).not.toBeDisabled()
  })

  it('clicking "→ card" POSTs to the card route and calls onMutate on success', async () => {
    const user = userEvent.setup()
    const onMutate = vi.fn()
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({ ok: true, status: 201, json: { entry: action({ cardId: 'card-1' }), card: { id: 'card-1' } } })
    )

    render(
      <MeetingPanel sessionId="s1" live boardId="b1" entries={[action({ id: 'e1', text: 'convertible' })]} onMutate={onMutate} />
    )
    await user.click(screen.getByRole('button', { name: 'Create card for "convertible"' }))

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/hud/entries/e1/card',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) })
    )
    expect(onMutate).toHaveBeenCalled()
  })

  it('surfaces a 409 convert error inline without calling onMutate', async () => {
    const user = userEvent.setup()
    const onMutate = vi.fn()
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({ ok: false, status: 409, json: { error: 'Card already created for this entry' } })
    )

    render(
      <MeetingPanel sessionId="s1" live boardId="b1" entries={[action({ id: 'e1', text: 'convertible' })]} onMutate={onMutate} />
    )
    await user.click(screen.getByRole('button', { name: 'Create card for "convertible"' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Card already created for this entry')
    expect(onMutate).not.toHaveBeenCalled()
  })

  it('shows a generic "assigned" chip and a due chip when assigneeName is not resolved', () => {
    render(
      <MeetingPanel
        sessionId="s1"
        live
        boardId="b1"
        entries={[action({ id: 'e1', assigneeId: 'u-brad', dueDate: '2026-07-17T00:00:00.000Z' })]}
        onMutate={vi.fn()}
      />
    )
    expect(screen.getByText('assigned')).toBeInTheDocument()
    expect(screen.getByText('due 2026-07-17')).toBeInTheDocument()
  })

  it('shows "@name" on the assignee chip when assigneeName is resolved', () => {
    render(
      <MeetingPanel
        sessionId="s1"
        live
        boardId="b1"
        entries={[action({ id: 'e1', assigneeId: 'u-brad', assigneeName: 'Brad Pitt' })]}
        onMutate={vi.fn()}
      />
    )
    expect(screen.getByText('@Brad Pitt')).toBeInTheDocument()
    expect(screen.queryByText('assigned')).not.toBeInTheDocument()
  })
})
