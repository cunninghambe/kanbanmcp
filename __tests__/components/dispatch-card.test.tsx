// @vitest-environment jsdom
/**
 * Tests for DispatchCard's proposed-change review link, which must carry a
 * `from=/hud/<hudId>` back-nav param (see docs/specs/2026-07-13-hud-meeting-manager.md
 * §3.6 and the changes-review back-nav follow-up).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DispatchCard } from '../../src/app/(app)/hud/_components/DispatchCard'
import type { Dispatch } from '../../src/app/(app)/hud/_components/DispatchCard'

vi.mock('../../src/app/(app)/hud/hud.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}))
vi.mock('@/components/design/Chip', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

function dispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'd-1',
    target: 'board',
    question: 'Which cards moved?',
    status: 'done',
    answer: 'Card A moved to Done.',
    citations: null,
    confidence: null,
    proposedChangeSetId: 'cs-1',
    error: null,
    createdAt: '2026-07-13T10:00:00.000Z',
    ...overrides,
  }
}

describe('DispatchCard — proposed change link', () => {
  it('POSITIVE: links to /changes/<changeSetId>?from=/hud/<hudId>', () => {
    render(<DispatchCard dispatch={dispatch()} hudId="hud-1" onCancel={() => {}} />)

    const link = screen.getByRole('link', { name: /review/ })
    expect(link).toHaveAttribute('href', '/changes/cs-1?from=%2Fhud%2Fhud-1')
  })

  it('NEGATIVE: renders no review link when there is no proposed change', () => {
    render(<DispatchCard dispatch={dispatch({ proposedChangeSetId: null })} hudId="hud-1" onCancel={() => {}} />)

    expect(screen.queryByRole('link', { name: /review/ })).not.toBeInTheDocument()
  })
})
