// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

// React 18 does not have `use()` — stub it so the page can render in jsdom.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    // `use(Promise)` in the page resolves params; stub it to unwrap synchronously.
    use: <T,>(p: Promise<T> | T): T => {
      if (p && typeof (p as Promise<T>).then === 'function') {
        throw new Error('use() stub only supports pre-resolved values in tests')
      }
      return p as T
    },
  }
})

const sessionState = vi.hoisted(() => ({ status: 'live' as 'live' | 'ended' }))

vi.mock('swr', () => ({
  default: vi.fn(() => ({
    data: {
      session: { id: 'h1', title: 'T', status: sessionState.status, boardId: 'b1', startedAt: new Date().toISOString() },
      dispatches: [],
    },
    mutate: vi.fn(),
  })),
}))
vi.mock('../../src/hooks/useHudStream', () => ({ useHudStream: vi.fn() }))
vi.mock('../../src/app/(app)/hud/_components/AgentConsole', () => ({
  AgentConsole: ({ onDispatch }: { onDispatch: (t: string, q: string) => void }) => (
    <button onClick={() => onDispatch('board', 'Which cards moved?')}>ask</button>
  ),
}))
vi.mock('../../src/app/(app)/hud/_components/DispatchCard', () => ({ DispatchCard: () => null }))
vi.mock('../../src/app/(app)/hud/_components/SituationRail', () => ({ SituationRail: () => null }))
vi.mock('../../src/app/(app)/hud/_components/WrapUp', () => ({
  WrapUp: ({ sessionId }: { sessionId: string }) => <div data-testid="wrap-up">{sessionId}</div>,
}))
vi.mock('../../src/app/(app)/hud/hud.module.css', () => ({
  default: { shell: 'shell', body: 'body', rail: 'rail', main: 'main', pulse: 'pulse', empty: 'empty', fleet: 'fleet' },
}))
vi.mock('@/components/design/Chip', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))
vi.mock('lucide-react', () => ({ RadioTower: () => null }))

beforeEach(() => {
  sessionState.status = 'live'
})

describe('HUD session page dispatch error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }))
  })

  it('shows a user-visible error when a dispatch POST fails', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const Page = (await import('../../src/app/(app)/hud/[id]/page')).default
    // Pass a plain object (not a Promise) so our `use()` stub can unwrap it synchronously.
    render(<Page params={{ id: 'h1' } as unknown as Promise<{ id: string }>} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'ask' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/boom|failed/i)
  })
})

describe('HUD session page — wrap-up transition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }))
  })

  it('live session renders AgentConsole and does not render WrapUp', async () => {
    const Page = (await import('../../src/app/(app)/hud/[id]/page')).default
    render(<Page params={{ id: 'h1' } as unknown as Promise<{ id: string }>} />)

    expect(await screen.findByRole('button', { name: 'ask' })).toBeInTheDocument()
    expect(screen.queryByTestId('wrap-up')).not.toBeInTheDocument()
  })

  it('ended session renders WrapUp instead of AgentConsole and the dispatch fleet', async () => {
    sessionState.status = 'ended'
    const Page = (await import('../../src/app/(app)/hud/[id]/page')).default
    render(<Page params={{ id: 'h1' } as unknown as Promise<{ id: string }>} />)

    expect(await screen.findByTestId('wrap-up')).toHaveTextContent('h1')
    expect(screen.queryByRole('button', { name: 'ask' })).not.toBeInTheDocument()
    expect(screen.queryByText('no agents dispatched')).not.toBeInTheDocument()
  })
})

describe('HUD session page — end session confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires two clicks: first shows "confirm end?", second POSTs /end', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const userEvent = (await import('@testing-library/user-event')).default
    const Page = (await import('../../src/app/(app)/hud/[id]/page')).default
    render(<Page params={{ id: 'h1' } as unknown as Promise<{ id: string }>} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'end session' }))

    expect(screen.getByRole('button', { name: 'confirm end?' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/hud/h1/end', expect.anything())

    await user.click(screen.getByRole('button', { name: 'confirm end?' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/hud/h1/end', expect.objectContaining({ method: 'POST' }))
  })
})
