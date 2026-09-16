// @vitest-environment jsdom
/**
 * SlackIntegrationRow + the integrations page banners — spec §7.3
 * "Integrations page" and §7.4. State machine against a mocked fetch. (WI-5)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { SlackIntegrationRow } from '../../src/app/(app)/settings/integrations/SlackIntegrationRow'
import { installFetch } from './_helpers/planner-fixtures'
import type { FetchCall, FetchReply } from './_helpers/planner-fixtures'

const nav = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/settings/integrations',
}))
vi.mock('../../src/components/layout/Header', () => ({ Header: () => <header /> }))

const STATUS_RE = /\/api\/me\/slack\/status$/
const CONNECTED = {
  connected: true,
  teamName: 'Acme',
  teamId: 'T1',
  teamUrl: 'https://acme.slack.com/',
  slackUserId: 'U123',
  scopes: ['search:read', 'chat:write'],
  lastUsedAt: '2026-09-16T08:00:00.000Z',
}

describe('SlackIntegrationRow', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows Connect Slack when disconnected', async () => {
    installFetch(() => ({ json: { connected: false } }))
    render(<SlackIntegrationRow />)
    expect(await screen.findByText('Not connected')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Connect Slack workspace' })
    expect(link).toHaveAttribute('href', '/api/me/slack/connect')
    expect(link).toHaveTextContent('Connect Slack')
  })

  it('shows the workspace when connected and disconnects with a DELETE', async () => {
    const user = userEvent.setup()
    const f = installFetch((c: FetchCall): FetchReply => {
      if (c.method === 'DELETE' && /\/api\/me\/slack\/disconnect$/.test(c.url))
        return { status: 204 }
      return { json: CONNECTED }
    })
    render(<SlackIntegrationRow />)
    expect(await screen.findByText(/Connected to/)).toHaveTextContent('Acme')
    await user.click(screen.getByRole('button', { name: 'Disconnect Slack workspace' }))
    await waitFor(() => expect(f.of('DELETE', /\/api\/me\/slack\/disconnect$/)).toHaveLength(1))
    expect(await screen.findByText('Not connected')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect Slack workspace' })).toBeInTheDocument()
  })

  it('a failed status load shows the error and Retry refetches', async () => {
    const user = userEvent.setup()
    const state = { fail: true }
    const f = installFetch(() =>
      state.fail ? { status: 500, json: { error: 'boom' } } : { json: { connected: false } }
    )
    render(<SlackIntegrationRow />)
    expect(await screen.findByText(/Status 500|boom/)).toBeInTheDocument()
    state.fail = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Not connected')).toBeInTheDocument()
    expect(f.of('GET', STATUS_RE)).toHaveLength(2)
  })

  it('a failed disconnect reports the server message', async () => {
    const user = userEvent.setup()
    installFetch((c) =>
      c.method === 'DELETE'
        ? { status: 500, json: { error: 'Failed to disconnect Slack' } }
        : { json: CONNECTED }
    )
    render(<SlackIntegrationRow />)
    await screen.findByText(/Connected to/)
    await user.click(screen.getByRole('button', { name: 'Disconnect Slack workspace' }))
    expect(await screen.findByText('Failed to disconnect Slack')).toBeInTheDocument()
  })
})

describe('Integrations page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    nav.search = ''
  })

  async function renderPage() {
    installFetch((c) =>
      /slack\/status/.test(c.url) ? { json: { connected: false } } : { json: { connected: false } }
    )
    const Page = (await import('../../src/app/(app)/settings/integrations/page')).default
    return render(<Page />)
  }

  it('renders both rows', async () => {
    await renderPage()
    expect(await screen.findByRole('link', { name: 'Connect Google account' })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Connect Slack workspace' })).toBeInTheDocument()
  })

  it('?connected=slack and ?slack_error=access_denied show their banners; ?connected=1 keeps the Google one', async () => {
    nav.search = 'connected=slack'
    const a = await renderPage()
    expect(await screen.findByRole('status')).toHaveTextContent('Slack connected successfully.')
    a.unmount()

    nav.search = 'slack_error=access_denied'
    const b = await renderPage()
    expect(await screen.findByRole('status')).toHaveTextContent('Slack connection was cancelled.')
    b.unmount()

    nav.search = 'connected=1'
    await renderPage()
    expect(await screen.findByRole('status')).toHaveTextContent('Google connected successfully.')
  })
})
