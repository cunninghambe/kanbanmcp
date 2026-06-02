import { RateLimitExceededError } from './errors'

export interface RateLimitOptions {
  capacity: number
  refillPerMinute: number
  maxWaitMs: number
}

const DEFAULT_OPTS: RateLimitOptions = { capacity: 60, refillPerMinute: 60, maxWaitMs: 30_000 }

type Bucket = { tokens: number; lastRefillMs: number }

const buckets = new Map<string, Bucket>()
let clock: () => number = () => Date.now()
let sleeper: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
let opts: RateLimitOptions = DEFAULT_OPTS

function getOpts(): RateLimitOptions {
  return opts
}

function refill(bucket: Bucket, now: number, opts: RateLimitOptions): void {
  const elapsed = now - bucket.lastRefillMs
  bucket.tokens = Math.min(opts.capacity, bucket.tokens + elapsed * (opts.refillPerMinute / 60_000))
  bucket.lastRefillMs = now
}

export async function consume(userId: string): Promise<void> {
  const opts = getOpts()

  if (!buckets.has(userId)) {
    buckets.set(userId, { tokens: opts.capacity, lastRefillMs: clock() })
  }

  const bucket = buckets.get(userId)!

  while (true) {
    const now = clock()
    refill(bucket, now, opts)

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return
    }

    const waitMs = Math.ceil((1 - bucket.tokens) * (60_000 / opts.refillPerMinute))
    if (waitMs > opts.maxWaitMs) {
      throw new RateLimitExceededError()
    }

    await sleeper(waitMs)
    // Advance the bucket's time reference by waitMs so refill() credits the
    // tokens that would have accumulated during the sleep, even when clock is frozen.
    bucket.lastRefillMs -= waitMs
  }
}

export function __resetBucketsForTests(): void {
  buckets.clear()
  opts = DEFAULT_OPTS
  clock = () => Date.now()
  sleeper = (ms) => new Promise((r) => setTimeout(r, ms))
}

export function __setOptsForTests(o: RateLimitOptions): void {
  opts = o
}

export function __setClockForTests(now: () => number): void {
  clock = now
}

export function __setSleeperForTests(s: (ms: number) => Promise<void>): void {
  sleeper = s
}
