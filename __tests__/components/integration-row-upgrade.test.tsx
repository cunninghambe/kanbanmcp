// @vitest-environment jsdom
/**
 * IntegrationRow (Google) — spec §7.3 "Integrations page": the planner-scope
 * CTA appears only when the status reports plannerScopes.granted === false.
 * The pre-existing states are untouched. (WI-5)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { IntegrationRow } from '../../src/app/(app)/settings/integrations/IntegrationRow'
import { installFetch } from './_helpers/planner-fixtures'

const BASE = {
  connected: true,
  email: 'beth@example.com',
  scopes: ['https://www.googleapis.com/auth/documents.readonly'],
  lastUsedAt: null,
  expired: false,
}

describe('IntegrationRow — planner scope upgrade CTA', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the CTA with the upgrade link when planner scopes are missing', async () => {
    installFetch(() => ({
      json: {
        ...BASE,
        plannerScopes: {
          granted: false,
          missing: [
            'https://www.googleapis.com/auth/calendar.events.readonly',
            'https://www.googleapis.com/auth/drive.file',
          ],
        },
      },
    }))
    render(<IntegrationRow integration="google" />)
    expect(
      await screen.findByText('today planner needs calendar + docs access')
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'enable for today' })).toHaveAttribute(
      'href',
      '/api/me/google/connect?upgrade=planner'
    )
    expect(screen.getByText('beth@example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect Google account' })).toBeInTheDocument()
  })

  it('hides the CTA when the scopes are granted, when disconnected, and when the field is absent', async () => {
    installFetch(() => ({ json: { ...BASE, plannerScopes: { granted: true, missing: [] } } }))
    const a = render(<IntegrationRow integration="google" />)
    await screen.findByText('beth@example.com')
    expect(screen.queryByText('today planner needs calendar + docs access')).toBeNull()
    a.unmount()
    vi.unstubAllGlobals()

    installFetch(() => ({ json: { connected: false } }))
    const b = render(<IntegrationRow integration="google" />)
    await screen.findByRole('link', { name: 'Connect Google account' })
    expect(screen.queryByText('today planner needs calendar + docs access')).toBeNull()
    b.unmount()
    vi.unstubAllGlobals()

    installFetch(() => ({ json: BASE }))
    render(<IntegrationRow integration="google" />)
    await screen.findByText('beth@example.com')
    expect(screen.queryByText('today planner needs calendar + docs access')).toBeNull()
  })
})
