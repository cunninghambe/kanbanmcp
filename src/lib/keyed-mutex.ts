/**
 * In-process async keyed mutex.
 *
 * Serializes async callbacks that share the same key by chaining them onto a
 * per-key promise. Callbacks with different keys run concurrently. The map
 * entry for a key is removed once its chain fully drains, so the map does not
 * grow unboundedly with one-shot keys.
 *
 * This is a valid concurrency primitive ONLY because the app runs as a single
 * Node process (one pm2 instance). It does not coordinate across processes.
 */

// Per-key tail of the promise chain. Resolves when the last queued callback
// for that key has settled. Absence of a key means no callback is in flight.
const chains = new Map<string, Promise<void>>()

/**
 * Runs `fn` after any previously-enqueued callback for the same `key` has
 * settled, guaranteeing that check-then-act critical sections sharing a key
 * never interleave within this process.
 *
 * The returned promise resolves/rejects with the result of `fn`. A rejection
 * from one callback does not poison the chain for subsequent callers: the tail
 * we wait on is swallowed, and each caller still observes its own outcome.
 */
export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Wait for the current tail (if any) without propagating its rejection.
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(() => fn())

  // The chain tail must never reject (otherwise it would poison later waiters)
  // and must resolve to void.
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  chains.set(key, tail)

  try {
    return await run
  } finally {
    // Only delete if we are still the tail — a later caller may have already
    // chained onto us, in which case that caller owns cleanup.
    if (chains.get(key) === tail) {
      chains.delete(key)
    }
  }
}

/** For tests: number of keys currently tracked. Should drain to 0 when idle. */
export function __activeKeyCountForTests(): number {
  return chains.size
}
