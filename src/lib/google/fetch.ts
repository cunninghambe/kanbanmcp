import { consume } from './rate-limit'

export type GoogleFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string>; json: () => Promise<unknown>; arrayBuffer?: () => Promise<ArrayBufferLike> }>

export type GoogleFetchOptions = {
  userId?: string
  retry?: boolean
}

// High-level stub: replaces googleFetch entirely (bypasses rate-limit + retry).
// Set by __setGoogleFetchForTests — used by existing module tests.
let stub: GoogleFetch | null = null

// Low-level stub: replaces only the raw HTTP call, leaving retry intact.
// Set by __setRawFetchForTests — used by fetch-retry tests.
let rawStub: GoogleFetch | null = null

let sleeper: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))

const RETRY_DELAYS = [1000, 4000, 16000]
const MAX_ATTEMPTS = 3

const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 409])

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

async function rawFetch(url: string, init: Parameters<GoogleFetch>[1]): ReturnType<GoogleFetch> {
  if (rawStub) return rawStub(url, init)
  return fetch(url, init) as ReturnType<GoogleFetch>
}

async function fetchWithRetry(url: string, init: Parameters<GoogleFetch>[1]): ReturnType<GoogleFetch> {
  let lastRes: Awaited<ReturnType<GoogleFetch>> | undefined
  let lastErr: unknown

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await rawFetch(url, init)
      if (!isRetryable(res.status) || PERMANENT_STATUSES.has(res.status)) return res
      lastRes = res
      if (attempt < MAX_ATTEMPTS - 1) await sleeper(RETRY_DELAYS[attempt])
    } catch (err) {
      lastErr = err
      if (attempt < MAX_ATTEMPTS - 1) await sleeper(RETRY_DELAYS[attempt])
    }
  }

  if (lastErr !== undefined) throw lastErr
  return lastRes!
}

export async function googleFetch(
  url: string,
  init?: Parameters<GoogleFetch>[1],
  opts?: GoogleFetchOptions,
): ReturnType<GoogleFetch> {
  // High-level stub bypasses rate-limit and retry — keeps existing tests hermetic.
  if (stub) return stub(url, init)
  if (opts?.userId) await consume(opts.userId)
  if (opts?.retry) return fetchWithRetry(url, init)
  return rawFetch(url, init)
}

/** Test seam: replaces googleFetch entirely (bypasses rate-limit + retry). */
export function __setGoogleFetchForTests(mock: GoogleFetch | null): void {
  stub = mock
}

/** Test seam: replaces only the raw HTTP layer (retry still fires). */
export function __setRawFetchForTests(mock: GoogleFetch | null): void {
  rawStub = mock
}

export function __setFetchSleeperForTests(s: (ms: number) => Promise<void>): void {
  sleeper = s
}
