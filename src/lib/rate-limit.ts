/**
 * Simple in-memory sliding-window rate limiter.
 * Not suitable for multi-process deployments — use a Redis-backed
 * solution if running multiple Node.js instances.
 */

interface Window {
  count: number
  resetAt: number
}

const store = new Map<string, Window>()

/**
 * Hard cap on the number of distinct keys held in memory. Without this,
 * an attacker who rotates the limiter key (e.g. forged IPs) could grow the
 * Map without bound and exhaust memory. When the cap is exceeded we sweep
 * expired windows first, and if still over, evict the oldest-inserted keys.
 */
export const MAX_KEYS = 10_000

/**
 * Removes every window whose reset time has passed. Map preserves insertion
 * order, so iterating gives us a cheap way to drop stale entries.
 */
function sweepExpired(now: number): void {
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) {
      store.delete(key)
    }
  }
}

/**
 * Enforces the MAX_KEYS cap. First drops expired windows; if the Map is still
 * at/over the cap, evicts the oldest-inserted keys (Map iteration order) until
 * there is room for one more key. Bounds worst-case memory regardless of how
 * many distinct keys are presented.
 */
function enforceCap(now: number): void {
  if (store.size < MAX_KEYS) return

  sweepExpired(now)

  // Still full of live windows — evict oldest-inserted entries to make room.
  while (store.size >= MAX_KEYS) {
    const oldest = store.keys().next()
    if (oldest.done) break
    store.delete(oldest.value)
  }
}

/**
 * Checks whether the given key has exceeded the allowed number of
 * requests within the rolling window. Increments the counter on
 * each call.
 *
 * @returns true if the request should be allowed, false if rate-limited.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  // Bypass entirely during Playwright e2e runs so multi-test suites are not blocked.
  if (process.env.PLAYWRIGHT_E2E) return true

  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now >= entry.resetAt) {
    // New (or expired) window for this key. Enforce the memory cap before
    // inserting so forged keys cannot grow the Map without bound.
    enforceCap(now)
    store.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }

  if (entry.count >= limit) {
    return false
  }

  entry.count++
  return true
}

/**
 * Test-only helper to reset the in-memory store between cases.
 * Not used in production code paths.
 */
export function __resetRateLimitStore(): void {
  store.clear()
}

/**
 * Test-only helper exposing the current number of tracked keys.
 */
export function __rateLimitStoreSize(): number {
  return store.size
}
