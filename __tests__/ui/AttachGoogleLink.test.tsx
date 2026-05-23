// @vitest-environment jsdom
/**
 * Tests for AttachGoogleLink component — all status codes + a11y + paste-to-submit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { AttachGoogleLink } from '../../src/components/board/AttachGoogleLink'

// ---- helpers ---------------------------------------------------------------

type FetchMock = ReturnType<typeof vi.fn>

function mockFetchOnce(body: unknown, status: number): void {
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

describe('AttachGoogleLink — idle render', () => {
  it('renders input and Attach button; button disabled when input empty', () => {
    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    expect(input).toBeInTheDocument()

    const btn = screen.getByRole('button', { name: /Attach Google Drive link/i })
    expect(btn).toBeDisabled()
  })

  it('enables button once input has a value', async () => {
    const user = userEvent.setup()
    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://docs.google.com/document/d/abc')

    expect(screen.getByRole('button', { name: /Attach Google Drive link/i })).not.toBeDisabled()
  })
})

describe('AttachGoogleLink — 201 happy path (single file)', () => {
  it('clears input, shows success, calls onAttached once', async () => {
    const user = userEvent.setup()
    const onAttached = vi.fn()
    mockFetchOnce({ artifact: { id: 'a1' } }, 201)

    render(<AttachGoogleLink cardId="card-1" onAttached={onAttached} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://docs.google.com/document/d/abc')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('Attached.')
    expect(onAttached).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('')
  })
})

describe('AttachGoogleLink — 201 folder happy path', () => {
  it('shows folder + N files summary when expandedArtifacts present', async () => {
    const user = userEvent.setup()
    mockFetchOnce(
      {
        artifact: { id: 'folder-1' },
        expandedArtifacts: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }],
      },
      201,
    )

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://drive.google.com/drive/folders/abc')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('Attached folder + 3 files.')
  })
})

describe('AttachGoogleLink — 400 INVALID_URL', () => {
  it('shows error message, preserves input value', async () => {
    const user = userEvent.setup()
    mockFetchOnce({ error: 'INVALID_URL' }, 400)

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'not-a-drive-url')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent("That doesn't look like a Drive URL.")
    expect(input).toHaveValue('not-a-drive-url')
  })
})

describe('AttachGoogleLink — 401 NOT_CONNECTED', () => {
  it('shows error with Connect Google link to /settings/integrations', async () => {
    const user = userEvent.setup()
    mockFetchOnce({ error: 'NOT_CONNECTED' }, 401)

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://drive.google.com/file/d/abc')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Connect Google in Settings')

    const link = screen.getByRole('link', { name: /Connect Google/i })
    expect(link).toHaveAttribute('href', '/settings/integrations')
  })
})

describe('AttachGoogleLink — 403 FORBIDDEN with fileId', () => {
  it('renders the file id in the error message', async () => {
    const user = userEvent.setup()
    mockFetchOnce({ error: 'FORBIDDEN', fileId: 'file-abc-123' }, 403)

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://drive.google.com/file/d/abc')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('file-abc-123')
    expect(screen.getByRole('alert')).toHaveTextContent("don't have access")
  })
})

describe('AttachGoogleLink — 404 TRASHED with fileId', () => {
  it('renders the file id in the error message', async () => {
    const user = userEvent.setup()
    mockFetchOnce({ error: 'TRASHED', fileId: 'trashed-file-xyz' }, 404)

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://drive.google.com/file/d/abc')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('trashed-file-xyz')
    expect(screen.getByRole('alert')).toHaveTextContent('not found or in trash')
  })
})

describe('AttachGoogleLink — 409 UNSUPPORTED_TYPE', () => {
  it('shows spec wording for unsupported type', async () => {
    const user = userEvent.setup()
    mockFetchOnce({ error: 'UNSUPPORTED_TYPE' }, 409)

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://drive.google.com/file/d/abc')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent("file type isn't supported")
    expect(screen.getByRole('alert')).toHaveTextContent('Docs, Sheets, Slides, folders')
  })
})

describe('AttachGoogleLink — 422 PARTIAL_FOLDER', () => {
  it('shows rejected list and toggle works', async () => {
    const user = userEvent.setup()
    const onAttached = vi.fn()
    mockFetchOnce(
      {
        error: 'PARTIAL_FOLDER',
        folder: { id: 'folder-1' },
        files: [{ id: 'f1' }, { id: 'f2' }],
        rejected: [
          { id: 'big-file', name: 'huge.pptx', reason: 'TOO_LARGE' },
          { id: 'deep-file', name: 'buried.docx', reason: 'TOO_MANY_FILES' },
        ],
      },
      422,
    )

    render(<AttachGoogleLink cardId="card-1" onAttached={onAttached} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://drive.google.com/drive/folders/abc')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByText(/Attached 2 files/)).toBeInTheDocument())
    expect(onAttached).toHaveBeenCalledTimes(1)

    // Rejected list initially collapsed
    expect(screen.queryByText('huge.pptx')).not.toBeInTheDocument()

    // Expand
    const toggleBtn = screen.getByRole('button', { name: /Show skipped/i })
    await user.click(toggleBtn)
    expect(screen.getByText(/huge.pptx/)).toBeInTheDocument()
    expect(screen.getByText(/buried.docx/)).toBeInTheDocument()

    // Collapse
    await user.click(screen.getByRole('button', { name: /Hide skipped/i }))
    expect(screen.queryByText('huge.pptx')).not.toBeInTheDocument()
  })
})

describe('AttachGoogleLink — submitting state', () => {
  it('disables button while in-flight and shows loading text', async () => {
    const user = userEvent.setup()
    let resolveRequest!: (value: unknown) => void
    ;(global.fetch as FetchMock).mockReturnValueOnce(
      new Promise((res) => {
        resolveRequest = res
      }),
    )

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://docs.google.com/document/d/abc')

    const btn = screen.getByRole('button', { name: /Attach Google Drive link/i })
    await user.click(btn)

    // Button should be disabled while in-flight
    expect(btn).toBeDisabled()

    // Resolve the in-flight request
    await act(async () => {
      resolveRequest({
        ok: true,
        status: 201,
        json: async () => ({ artifact: { id: 'a1' } }),
      })
    })

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
  })
})

describe('AttachGoogleLink — 5xx generic error', () => {
  it('shows generic error on network failure', async () => {
    const user = userEvent.setup()
    mockFetchRejects('fetch failed')

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://docs.google.com/document/d/abc')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Google was unreachable')
  })
})

describe('AttachGoogleLink — accessibility', () => {
  it('input has an associated label (sr-only)', () => {
    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    expect(input).toBeInTheDocument()
  })

  it('error uses role="alert" with aria-live="assertive"', async () => {
    const user = userEvent.setup()
    mockFetchOnce({ error: 'INVALID_URL' }, 400)

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'bad-url')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert).toBeInTheDocument()
      expect(alert).toHaveAttribute('aria-live', 'assertive')
    })
  })

  it('focus returns to input after success (after 2s timeout)', async () => {
    const user = userEvent.setup()
    mockFetchOnce({ artifact: { id: 'a1' } }, 201)

    render(<AttachGoogleLink cardId="card-1" onAttached={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })
    await user.type(input, 'https://docs.google.com/document/d/abc')
    await user.click(screen.getByRole('button', { name: /Attach Google Drive link/i }))

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())

    // After the 2s success window the component calls inputRef.current.focus().
    // waitFor with a generous timeout lets the real timer elapse.
    await waitFor(() => expect(document.activeElement).toBe(input), { timeout: 3500 })
  }, 15000)
})

describe('AttachGoogleLink — paste-to-submit', () => {
  it('auto-submits when a Drive URL is pasted via clipboard event', async () => {
    const onAttached = vi.fn()
    mockFetchOnce({ artifact: { id: 'a1' } }, 201)

    render(<AttachGoogleLink cardId="card-1" onAttached={onAttached} />)

    const input = screen.getByRole('textbox', { name: /Google Drive URL/i })

    // Simulate a paste clipboard event with Drive URL data
    const driveUrl = 'https://docs.google.com/document/d/auto-submit-test'
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => (type === 'text' ? driveUrl : ''),
      },
    })

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(onAttached).toHaveBeenCalledTimes(1)
  })
})
