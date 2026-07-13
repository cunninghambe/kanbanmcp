// @vitest-environment jsdom
/**
 * Tests for useBoard's SWR fetcher. A non-ok response (e.g. GET /api/boards/<id>
 * for a board that doesn't exist, which returns {error:"Board not found"} with a
 * 404) must surface as an error, not resolve with the error body as if it were
 * board data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { useBoard } from '../../src/hooks/useBoard'

function freshCacheWrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
      {children}
    </SWRConfig>
  )
}

describe('useBoard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('surfaces a non-ok response as an error instead of resolving with the error body as board data', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Board not found' }),
    } as Response)

    const { result } = renderHook(() => useBoard('nonexistent-board'), {
      wrapper: freshCacheWrapper,
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.board).toBeNull()
  })

  it('resolves with the unwrapped board on a successful response', async () => {
    const board = { id: 'board-1', name: 'Test Board', columns: [] }
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ board }),
    } as Response)

    const { result } = renderHook(() => useBoard('board-1'), {
      wrapper: freshCacheWrapper,
    })

    await waitFor(() => expect(result.current.board).toEqual(board))
    expect(result.current.isError).toBe(false)
  })
})
