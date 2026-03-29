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
 * Checks whether the given key has exceeded the allowed number of
 * requests within the rolling window. Increments the counter on
 * each call.
 *
 * @returns true if the request should be allowed, false if rate-limited.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): boolean {
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }

  if (entry.count >= limit) {
    return false
  }

  entry.count++
  return true
}
