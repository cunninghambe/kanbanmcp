// @vitest-environment jsdom
/**
 * Tests for IntegrationRow component — three states + interactions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { IntegrationRow } from '../../src/app/(app)/settings/integrations/IntegrationRow'

// ---- helpers ---------------------------------------------------------------

type FetchMock = ReturnType<typeof vi.fn>

function mockFetchOnce(body: unknown, status = 200): void {
  ;(global.fetch as FetchMock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response)
}

function mockFetchRejects(message = 'Network error'): void {
  ;(global.fetch as FetchMock).mockRejectedValueOnce(new Error(message))
}

// ---- setup -----------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- tests -----------------------------------------------------------------

describe('IntegrationRow — disconnected state', () => {
  it('renders "Connect Google" link with correct href and no Disconnect button', async () => {
    mockFetchOnce({ connected: false })

    render(<IntegrationRow integration="google" />)

    const btn = await screen.findByRole('link', { name: /Connect Google account/i })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('href', '/api/me/google/connect')
    expect(screen.queryByRole('button', { name: /Disconnect/i })).not.toBeInTheDocument()
  })
})

describe('IntegrationRow — connected state', () => {
  it('shows email, last-used Never, and Disconnect button', async () => {
    mockFetchOnce({
      connected: true,
      email: 'a@b.com',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      lastUsedAt: null,
      expired: false,
    })

    render(<IntegrationRow integration="google" />)

    await waitFor(() => {
      expect(screen.getByText(/Connected as/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/a@b\.com/)).toBeInTheDocument()
    expect(screen.getByText(/Last used:/i)).toBeInTheDocument()
    expect(screen.getByText(/Never/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Disconnect Google account/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Connect Google account/i })).not.toBeInTheDocument()
  })
})

describe('IntegrationRow — expired state', () => {
  it('shows Reconnect button and no Disconnect button', async () => {
    mockFetchOnce({
      connected: true,
      email: 'a@b.com',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      lastUsedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      expired: true,
    })

    render(<IntegrationRow integration="google" />)

    const reconnectBtn = await screen.findByRole('link', { name: /Reconnect Google account/i })
    expect(reconnectBtn).toBeInTheDocument()
    expect(reconnectBtn).toHaveAttribute('href', '/api/me/google/connect')
    expect(screen.queryByRole('button', { name: /Disconnect/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Reconnect to keep AI reviews working/i)).toBeInTheDocument()
  })
})

describe('IntegrationRow — disconnect interaction', () => {
  it('transitions to disconnected on successful DELETE (204)', async () => {
    // Initial status: connected
    mockFetchOnce({
      connected: true,
      email: 'a@b.com',
      scopes: [],
      lastUsedAt: null,
      expired: false,
    })

    render(<IntegrationRow integration="google" />)

    const disconnectBtn = await screen.findByRole('button', { name: /Disconnect Google account/i })

    // Stub the DELETE → 204
    ;(global.fetch as FetchMock).mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({}),
    } as Response)

    const user = userEvent.setup()
    await user.click(disconnectBtn)

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Connect Google account/i })).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /Disconnect/i })).not.toBeInTheDocument()
  })

  it('shows error state when DELETE returns 500', async () => {
    mockFetchOnce({
      connected: true,
      email: 'a@b.com',
      scopes: [],
      lastUsedAt: null,
      expired: false,
    })

    render(<IntegrationRow integration="google" />)

    const disconnectBtn = await screen.findByRole('button', { name: /Disconnect Google account/i })

    ;(global.fetch as FetchMock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' }),
    } as Response)

    const user = userEvent.setup()
    await user.click(disconnectBtn)

    await waitFor(() => {
      expect(screen.getByText(/Server error/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
  })
})

describe('IntegrationRow — status fetch error', () => {
  it('shows error state with Retry button when initial fetch rejects', async () => {
    mockFetchRejects('Network error')

    render(<IntegrationRow integration="google" />)

    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
  })

  it('re-fetches status when Retry is clicked', async () => {
    mockFetchRejects('Timeout')

    render(<IntegrationRow integration="google" />)

    await screen.findByRole('button', { name: /Retry/i })

    // Retry fetch resolves to disconnected
    mockFetchOnce({ connected: false })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Retry/i }))

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Connect Google account/i })).toBeInTheDocument()
    })
  })
})

describe('IntegrationRow — accessibility', () => {
  it('the connect button is reachable with fewer than 5 tabs from the row', async () => {
    mockFetchOnce({ connected: false })

    const { container } = render(<IntegrationRow integration="google" />)

    await screen.findByRole('link', { name: /Connect Google account/i })

    const user = userEvent.setup()

    // Focus the container first element by tabbing from body
    container.focus?.()
    let tabCount = 0
    while (tabCount < 5) {
      await user.tab()
      tabCount++
      if (document.activeElement === screen.getByRole('link', { name: /Connect Google account/i })) {
        break
      }
    }

    expect(document.activeElement).toBe(screen.getByRole('link', { name: /Connect Google account/i }))
    expect(tabCount).toBeLessThan(5)
  })
})
