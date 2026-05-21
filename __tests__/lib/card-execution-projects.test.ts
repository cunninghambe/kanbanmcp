/**
 * Unit tests for src/lib/card-execution/projects.ts (Task 5 — TDD)
 *
 * The module under test does NOT exist yet. These tests will fail to import
 * until Task 6 lands. That is the correct TDD state.
 *
 * Functions under test:
 *   slugifyBoardName(name: string): string
 *   isProjectRegistered(slug: string): Promise<boolean>
 *   resetProjectCacheForTests(): void
 *
 * The module must also expose:
 *   __setListProjectsForTests(fn: () => Promise<string[]>): void
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  slugifyBoardName,
  isProjectRegistered,
  resetProjectCacheForTests,
  __setListProjectsForTests,
} from '../../src/lib/card-execution/projects'

// ---------------------------------------------------------------------------
// slugifyBoardName
// ---------------------------------------------------------------------------

describe('slugifyBoardName', () => {
  it("lowercases a plain name: 'Spoonworks' → 'spoonworks'", () => {
    expect(slugifyBoardName('Spoonworks')).toBe('spoonworks')
  })

  it("replaces non-alphanumeric chars with hyphens: 'My Board!' → 'my-board'", () => {
    expect(slugifyBoardName('My Board!')).toBe('my-board')
  })

  it("trims leading/trailing whitespace: '  spoonworks  ' → 'spoonworks'", () => {
    // Whitespace is non-alphanumeric so it becomes '-', then outer '-' is trimmed.
    expect(slugifyBoardName('  spoonworks  ')).toBe('spoonworks')
  })

  it("collapses consecutive non-alphanumeric runs into a single hyphen: 'Board__-Name' → 'board-name'", () => {
    expect(slugifyBoardName('Board__-Name')).toBe('board-name')
  })

  it("trims leading and trailing hyphens: '--leading-trailing--' → 'leading-trailing'", () => {
    expect(slugifyBoardName('--leading-trailing--')).toBe('leading-trailing')
  })

  it("replaces spaces between words: 'Auto Geny' → 'auto-geny'", () => {
    expect(slugifyBoardName('Auto Geny')).toBe('auto-geny')
  })

  it("strips non-ASCII characters: 'Übercoder' → 'bercoder'", () => {
    // 'Ü' is non-ASCII and does not match [a-z0-9] after lowercasing ('ü').
    // The implementation replaces any run of [^a-z0-9] with '-', then trims
    // leading/trailing '-'. So 'Übercoder' → '-bercoder' → 'bercoder'.
    //
    // Chosen behavior: strip non-ASCII (do not transliterate). This keeps the
    // implementation dependency-free (no ICU/unidecode). If the board name is
    // fully non-ASCII the result may be empty-string — acceptable edge case for
    // M2 (ClaudeMCP project names are expected to be ASCII).
    expect(slugifyBoardName('Übercoder')).toBe('bercoder')
  })
})

// ---------------------------------------------------------------------------
// isProjectRegistered — cache behaviour
// ---------------------------------------------------------------------------

describe('isProjectRegistered', () => {
  beforeEach(() => {
    resetProjectCacheForTests()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('first call hits the underlying listClaudeProjects and returns true when slug is present', async () => {
    const spy = vi.fn<[], Promise<string[]>>().mockResolvedValue(['spoonworks', 'other-project'])
    __setListProjectsForTests(spy)

    const result = await isProjectRegistered('spoonworks')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(result).toBe(true)
  })

  it('first call returns false when slug is absent', async () => {
    const spy = vi.fn<[], Promise<string[]>>().mockResolvedValue(['other-project'])
    __setListProjectsForTests(spy)

    const result = await isProjectRegistered('spoonworks')

    expect(result).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('second call within 60s uses the cache and does NOT hit the underlying function', async () => {
    const spy = vi.fn<[], Promise<string[]>>().mockResolvedValue(['spoonworks'])
    __setListProjectsForTests(spy)

    await isProjectRegistered('spoonworks')

    // Advance time but stay under the 60s TTL
    vi.advanceTimersByTime(59_000)

    await isProjectRegistered('spoonworks')

    // Underlying should only have been called once despite two isProjectRegistered calls
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('after 60s the next call re-fetches from the underlying function', async () => {
    const spy = vi.fn<[], Promise<string[]>>().mockResolvedValue(['spoonworks'])
    __setListProjectsForTests(spy)

    await isProjectRegistered('spoonworks')
    expect(spy).toHaveBeenCalledTimes(1)

    // Expire the 60s TTL
    vi.advanceTimersByTime(61_000)

    await isProjectRegistered('spoonworks')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('resetProjectCacheForTests forces a re-fetch on the very next call', async () => {
    const spy = vi.fn<[], Promise<string[]>>().mockResolvedValue(['spoonworks'])
    __setListProjectsForTests(spy)

    await isProjectRegistered('spoonworks')
    expect(spy).toHaveBeenCalledTimes(1)

    // Reset cache explicitly — simulates test isolation helper
    resetProjectCacheForTests()

    await isProjectRegistered('spoonworks')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('propagates errors thrown by the underlying listClaudeProjects without swallowing them', async () => {
    const networkError = new Error('ECONNREFUSED — ClaudeMCP unreachable')
    const spy = vi.fn<[], Promise<string[]>>().mockRejectedValue(networkError)
    __setListProjectsForTests(spy)

    await expect(isProjectRegistered('spoonworks')).rejects.toThrow(
      'ECONNREFUSED — ClaudeMCP unreachable',
    )
  })
})
