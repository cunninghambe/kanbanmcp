// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

// SWR is mocked to return the configurable enabled-target set without any fetch.
let enabledTargets: string[] = ['board', 'drive', 'email', 'slack']
vi.mock('swr', () => ({ default: () => ({ data: { enabledTargets } }) }))
vi.mock('../../src/app/(app)/hud/hud.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock('lucide-react', () => ({
  LayoutGrid: () => null,
  HardDrive: () => null,
  Mail: () => null,
  Hash: () => null,
  Send: () => null,
}))

import { AgentConsole } from '../../src/app/(app)/hud/_components/AgentConsole'

function renderConsole() {
  return render(<AgentConsole live busy={false} onDispatch={vi.fn()} />)
}

beforeEach(() => {
  enabledTargets = ['board', 'drive', 'email', 'slack']
})

describe('AgentConsole target gating', () => {
  it('enables all target chips when all are configured', () => {
    renderConsole()
    for (const label of ['board', 'drive', 'email', 'slack']) {
      const chip = screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })
      expect(chip).toBeEnabled()
      expect(chip).toHaveAttribute('aria-disabled', 'false')
    }
  })

  it('marks unavailable chips aria-disabled with a screen-reader reason, still focusable', () => {
    enabledTargets = ['board', 'drive']
    renderConsole()
    expect(screen.getByRole('button', { name: /^board$/i })).toHaveAttribute('aria-disabled', 'false')
    expect(screen.getByRole('button', { name: /^drive$/i })).toHaveAttribute('aria-disabled', 'false')
    for (const label of ['email', 'slack']) {
      const chip = screen.getByRole('button', { name: new RegExp(label, 'i') })
      expect(chip).toHaveAttribute('aria-disabled', 'true')
      // Not natively disabled — stays focusable so screen readers reach the reason.
      expect(chip).toBeEnabled()
      // The reason is exposed to assistive tech via a visually-hidden span.
      expect(chip).toHaveTextContent(/not configured for this deployment/i)
    }
  })

  it('ignores clicks on an aria-disabled chip', async () => {
    enabledTargets = ['board', 'drive']
    renderConsole()
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    const slack = screen.getByRole('button', { name: /slack/i })
    await user.click(slack)
    expect(slack).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /^board$/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('falls back off a disabled default target to the first enabled one', async () => {
    enabledTargets = ['drive', 'email']
    renderConsole()
    // Default is board, which is disabled here → derived target switches to drive.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^drive$/i })).toHaveAttribute('aria-pressed', 'true')
    )
    expect(screen.getByRole('button', { name: /board/i })).toHaveAttribute('aria-pressed', 'false')
  })
})
