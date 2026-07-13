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
      expect(screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })).toBeEnabled()
    }
  })

  it('disables chips for targets absent from the enabled set', () => {
    enabledTargets = ['board', 'drive']
    renderConsole()
    expect(screen.getByRole('button', { name: /^board$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^drive$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^email$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^slack$/i })).toBeDisabled()
  })

  it('falls back off a disabled default target to the first enabled one', async () => {
    enabledTargets = ['drive', 'email']
    renderConsole()
    // Default is board, which is disabled here → effect switches to drive.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^drive$/i })).toHaveAttribute('aria-pressed', 'true')
    )
    expect(screen.getByRole('button', { name: /^board$/i })).toHaveAttribute('aria-pressed', 'false')
  })
})
