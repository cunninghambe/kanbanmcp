// @vitest-environment jsdom
/**
 * Tests for /changes/[changeSetId]/page.tsx reading the `from` search param
 * and passing it through to ChangeSetReview as `backHref` only when it is a
 * safe internal path — see docs/specs/2026-07-13-hud-meeting-manager.md §3.6
 * and the changes-review back-nav follow-up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

// React 18 does not have `use()` — stub it so the page can render in jsdom.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    use: <T,>(p: Promise<T> | T): T => {
      if (p && typeof (p as Promise<T>).then === 'function') {
        throw new Error('use() stub only supports pre-resolved values in tests')
      }
      return p as T
    },
  }
})

const searchParamsState = vi.hoisted(() => ({ value: '' }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParamsState.value),
}))

vi.mock('@/components/changes/ChangeSetReview', () => ({
  ChangeSetReview: ({ changeSetId, backHref }: { changeSetId: string; backHref?: string }) => (
    <div data-testid="review" data-change-set-id={changeSetId} data-back-href={backHref ?? ''} />
  ),
}))

beforeEach(() => {
  searchParamsState.value = ''
})

describe('ChangeSetReviewPage — ?from= back-nav', () => {
  it('POSITIVE: passes a safe internal from= value through as backHref', async () => {
    searchParamsState.value = `from=${encodeURIComponent('/hud/h1')}`
    const Page = (await import('../../src/app/(app)/changes/[changeSetId]/page')).default
    render(<Page params={{ changeSetId: 'cs-1' } as unknown as Promise<{ changeSetId: string }>} />)

    const review = await screen.findByTestId('review')
    expect(review).toHaveAttribute('data-change-set-id', 'cs-1')
    expect(review).toHaveAttribute('data-back-href', '/hud/h1')
  })

  it('NEGATIVE: a protocol-relative from= (//evil.com) is dropped, falling back to ChangeSetReview default', async () => {
    searchParamsState.value = 'from=%2F%2Fevil.com'
    const Page = (await import('../../src/app/(app)/changes/[changeSetId]/page')).default
    render(<Page params={{ changeSetId: 'cs-1' } as unknown as Promise<{ changeSetId: string }>} />)

    const review = await screen.findByTestId('review')
    expect(review).toHaveAttribute('data-back-href', '')
  })

  it('NEGATIVE: an absolute from= with a scheme (https://…) is dropped, falling back to ChangeSetReview default', async () => {
    searchParamsState.value = `from=${encodeURIComponent('https://evil.com')}`
    const Page = (await import('../../src/app/(app)/changes/[changeSetId]/page')).default
    render(<Page params={{ changeSetId: 'cs-1' } as unknown as Promise<{ changeSetId: string }>} />)

    const review = await screen.findByTestId('review')
    expect(review).toHaveAttribute('data-back-href', '')
  })

  it('EDGE: no from= param at all leaves backHref unset', async () => {
    const Page = (await import('../../src/app/(app)/changes/[changeSetId]/page')).default
    render(<Page params={{ changeSetId: 'cs-1' } as unknown as Promise<{ changeSetId: string }>} />)

    const review = await screen.findByTestId('review')
    expect(review).toHaveAttribute('data-back-href', '')
  })
})
