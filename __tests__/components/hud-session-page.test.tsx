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

vi.mock('swr', () => ({
  default: vi.fn(() => ({
    data: {
      session: { id: 'h1', title: 'T', status: 'live', boardId: 'b1', startedAt: new Date().toISOString() },
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
vi.mock('../../src/app/(app)/hud/hud.module.css', () => ({
  default: { shell: 'shell', body: 'body', rail: 'rail', main: 'main', pulse: 'pulse', empty: 'empty', fleet: 'fleet' },
}))
vi.mock('@/components/design/Chip', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))
vi.mock('lucide-react', () => ({ RadioTower: () => null }))

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
