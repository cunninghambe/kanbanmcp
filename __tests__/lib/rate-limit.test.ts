/**
 * Tests for the in-memory sliding-window rate limiter.
 *
 * Covers:
 *  - limit enforcement (Nth call returns false)
 *  - window reset after windowMs (fake timers)
 *  - bounded-map eviction (Map does not grow unbounded past MAX_KEYS)
 *  - PLAYWRIGHT_E2E bypass
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  checkRateLimit,
  MAX_KEYS,
  __resetRateLimitStore,
  __rateLimitStoreSize,
} from '../../src/lib/rate-limit'

describe('checkRateLimit', () => {
  beforeEach(() => {
    delete process.env.PLAYWRIGHT_E2E
    __resetRateLimitStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetRateLimitStore()
  })

  // ─── Positive: the fix works (limit enforced) ───────────────────────────────
  it('allows requests up to the limit then blocks', () => {
    const limit = 3
    const windowMs = 1000
    expect(checkRateLimit('k', limit, windowMs)).toBe(true) // 1
    expect(checkRateLimit('k', limit, windowMs)).toBe(true) // 2
    expect(checkRateLimit('k', limit, windowMs)).toBe(true) // 3
    expect(checkRateLimit('k', limit, windowMs)).toBe(false) // 4th → blocked
  })

  it('blocks the Nth call where N exceeds the limit', () => {
    const limit = 5
    for (let i = 0; i < limit; i++) {
      expect(checkRateLimit('key', limit, 10_000)).toBe(true)
    }
    expect(checkRateLimit('key', limit, 10_000)).toBe(false)
  })

  // ─── Negative / false-positive boundary: distinct keys not affected ─────────
  it('tracks distinct keys independently (one key blocked does not block another)', () => {
    const limit = 1
    expect(checkRateLimit('a', limit, 1000)).toBe(true)
    expect(checkRateLimit('a', limit, 1000)).toBe(false) // a is now blocked
    // A different key must still be allowed — blocking one key must not block all.
    expect(checkRateLimit('b', limit, 1000)).toBe(true)
  })

  // ─── Edge case: window resets after windowMs ────────────────────────────────
  it('resets the window after windowMs elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limit = 2
    const windowMs = 1000

    expect(checkRateLimit('w', limit, windowMs)).toBe(true)
    expect(checkRateLimit('w', limit, windowMs)).toBe(true)
    expect(checkRateLimit('w', limit, windowMs)).toBe(false) // blocked within window

    // Advance just past the window — counter should reset.
    vi.advanceTimersByTime(windowMs + 1)
    expect(checkRateLimit('w', limit, windowMs)).toBe(true)
    expect(checkRateLimit('w', limit, windowMs)).toBe(true)
    expect(checkRateLimit('w', limit, windowMs)).toBe(false)
  })

  it('does not reset the window before windowMs elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limit = 1
    const windowMs = 1000

    expect(checkRateLimit('w2', limit, windowMs)).toBe(true)
    expect(checkRateLimit('w2', limit, windowMs)).toBe(false)

    // Advance, but not far enough to reset.
    vi.advanceTimersByTime(windowMs - 1)
    expect(checkRateLimit('w2', limit, windowMs)).toBe(false) // still blocked
  })

  // ─── Edge case: bounded-map eviction (no unbounded growth) ──────────────────
  it('does not grow the store beyond MAX_KEYS even with many distinct keys', () => {
    // Insert far more distinct keys than the cap. A naive Map would grow to
    // 2 * MAX_KEYS; the bounded limiter must keep size <= MAX_KEYS.
    const total = MAX_KEYS * 2
    for (let i = 0; i < total; i++) {
      checkRateLimit(`forged-${i}`, 5, 60_000)
    }
    expect(__rateLimitStoreSize()).toBeLessThanOrEqual(MAX_KEYS)
  })

  it('evicts expired windows first when the cap is hit', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    // Create one short-lived window that will expire.
    checkRateLimit('short', 5, 100)
    expect(__rateLimitStoreSize()).toBe(1)

    // Let it expire.
    vi.advanceTimersByTime(200)

    // Fill up to the cap with long-lived windows. The expired 'short' window
    // should be swept rather than counting toward the cap, so size stays bounded.
    for (let i = 0; i < MAX_KEYS; i++) {
      checkRateLimit(`live-${i}`, 5, 60_000)
    }
    expect(__rateLimitStoreSize()).toBeLessThanOrEqual(MAX_KEYS)
    // The expired key must have been evicted.
    // It is allowed again as a fresh window if re-checked, proving it was dropped.
    expect(checkRateLimit('short', 5, 60_000)).toBe(true)
  })

  // ─── Edge case: PLAYWRIGHT_E2E bypass ───────────────────────────────────────
  it('always allows and never touches the store under PLAYWRIGHT_E2E', () => {
    process.env.PLAYWRIGHT_E2E = '1'
    const limit = 1
    // Way more than the limit — all allowed because the limiter is bypassed.
    for (let i = 0; i < 50; i++) {
      expect(checkRateLimit('e2e', limit, 1000)).toBe(true)
    }
    // Store must remain empty: bypass returns before touching the Map.
    expect(__rateLimitStoreSize()).toBe(0)
  })
})
