// @vitest-environment jsdom
/**
 * Tests for ArtifactList component
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ArtifactList } from '../../src/components/board/ArtifactList'
import type { ArtifactResponse } from '../../src/lib/artifacts'

// SWR needs to be mocked to avoid network calls in tests
vi.mock('swr', () => ({
  default: vi.fn(),
}))

import useSWR from 'swr'

const mockUseSWR = vi.mocked(useSWR)

const baseArtifact: ArtifactResponse = {
  id: 'artifact-1',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 102400,
  source: 'UPLOAD',
  createdAt: new Date('2026-01-01T12:00:00Z').toISOString(),
  uploader: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
  reviews: [],
}

const artifactWithDoneReview: ArtifactResponse = {
  ...baseArtifact,
  id: 'artifact-2',
  filename: 'spec.md',
  reviews: [
    {
      id: 'review-1',
      status: 'done',
      model: 'claude-sonnet-4-6',
      createdAt: new Date('2026-01-01T12:05:00Z').toISOString(),
      startedAt: new Date('2026-01-01T12:04:00Z').toISOString(),
      finishedAt: new Date('2026-01-01T12:05:00Z').toISOString(),
    },
  ],
}

const artifactWithPendingReview: ArtifactResponse = {
  ...baseArtifact,
  id: 'artifact-3',
  filename: 'code.py',
  reviews: [
    {
      id: 'review-2',
      status: 'pending',
      model: 'claude-sonnet-4-6',
      createdAt: new Date('2026-01-01T12:05:00Z').toISOString(),
      startedAt: null,
      finishedAt: null,
    },
  ],
}

function setupMockSWR(artifacts: ArtifactResponse[], opts?: { isLoading?: boolean; error?: Error }) {
  mockUseSWR.mockReturnValue({
    data: opts?.isLoading ? undefined : { artifacts },
    error: opts?.error,
    isLoading: opts?.isLoading ?? false,
    mutate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useSWR>)
}

describe('ArtifactList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows empty state when there are no artifacts', () => {
    setupMockSWR([])
    render(<ArtifactList cardId="card-1" canDelete={() => false} />)
    expect(screen.getByText(/No artifacts yet/i)).toBeInTheDocument()
  })

  it('renders artifact list with filename, size, and uploader', () => {
    setupMockSWR([baseArtifact])
    render(<ArtifactList cardId="card-1" canDelete={() => false} />)

    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText(/100\.0 KB/i)).toBeInTheDocument()
    expect(screen.getByText(/Alice/i)).toBeInTheDocument()
  })

  it('renders "Done" AI review status badge', () => {
    setupMockSWR([artifactWithDoneReview])
    render(<ArtifactList cardId="card-1" canDelete={() => false} />)

    // Badge with aria-label
    expect(screen.getByLabelText('AI review status: Done')).toBeInTheDocument()
    // "View review" link for done status
    expect(screen.getByRole('link', { name: /View review/i })).toBeInTheDocument()
  })

  it('renders "Pending" AI review status badge', () => {
    setupMockSWR([artifactWithPendingReview])
    render(<ArtifactList cardId="card-1" canDelete={() => false} />)

    expect(screen.getByLabelText('AI review status: Pending')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /View review/i })).not.toBeInTheDocument()
  })

  it('shows delete button only when canDelete returns true', () => {
    setupMockSWR([baseArtifact])
    const { rerender } = render(
      <ArtifactList cardId="card-1" canDelete={() => false} />
    )
    expect(screen.queryByRole('button', { name: /Delete report\.pdf/i })).not.toBeInTheDocument()

    rerender(<ArtifactList cardId="card-1" canDelete={() => true} />)
    expect(screen.getByRole('button', { name: /Delete report\.pdf/i })).toBeInTheDocument()
  })

  it('shows loading skeleton while fetching', () => {
    setupMockSWR([], { isLoading: true })
    const { container } = render(<ArtifactList cardId="card-1" canDelete={() => false} />)
    // Loading state renders animated divs
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
  })

  it('shows error state with retry button on fetch failure', () => {
    setupMockSWR([], { error: new Error('Network error') })
    render(<ArtifactList cardId="card-1" canDelete={() => false} />)

    expect(screen.getByText(/Could not load artifacts/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
  })

  it('renders upload form with file input and button', () => {
    setupMockSWR([])
    render(<ArtifactList cardId="card-1" canDelete={() => false} />)

    expect(screen.getByRole('button', { name: /Upload artifact/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/Choose file to upload/i)).toBeInTheDocument()
  })

  it('shows 415 error inline when server rejects file type', async () => {
    setupMockSWR([])

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 415,
      json: async () => ({}),
    } as Response)

    const { container } = render(<ArtifactList cardId="card-1" canDelete={() => false} />)

    const fileInput = screen.getByLabelText(/Choose file to upload/i) as HTMLInputElement
    const file = new File(['data'], 'archive.zip', { type: 'application/zip' })

    // Use fireEvent.change to set file on input in jsdom (user-event doesn't reliably set FileList on refs)
    Object.defineProperty(fileInput, 'files', {
      value: { 0: file, length: 1, item: () => file },
      writable: false,
      configurable: true,
    })
    fireEvent.change(fileInput)

    const form = container.querySelector('form')!
    fireEvent.submit(form)

    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toHaveTextContent(/File type not supported/i)
      },
      { timeout: 3000 }
    )
  })

  it('shows 413 error inline when file is too large', async () => {
    setupMockSWR([])

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 413,
      json: async () => ({}),
    } as Response)

    const { container } = render(<ArtifactList cardId="card-1" canDelete={() => false} />)

    const fileInput = screen.getByLabelText(/Choose file to upload/i) as HTMLInputElement
    const file = new File(['x'.repeat(100)], 'big.pdf', { type: 'application/pdf' })

    Object.defineProperty(fileInput, 'files', {
      value: { 0: file, length: 1, item: () => file },
      writable: false,
      configurable: true,
    })
    fireEvent.change(fileInput)

    const form = container.querySelector('form')!
    fireEvent.submit(form)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/File too large/i)
    })
  })
})
