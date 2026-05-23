import { describe, it, expect, beforeEach } from 'vitest'
import {
  consume,
  __resetBucketsForTests,
  __setClockForTests,
  __setSleeperForTests,
  __setOptsForTests,
} from '../../../src/lib/google/rate-limit'
import { RateLimitExceededError } from '../../../src/lib/google/errors'

function makeFakeSleeper(): { sleeper: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = []
  return {
    sleeper: (ms: number) => {
      calls.push(ms)
      return Promise.resolve()
    },
    calls,
  }
}

beforeEach(() => {
  __resetBucketsForTests()
})

describe('token bucket — rate-limit.ts', () => {
  it('starts at capacity: 60 consecutive consume calls resolve without sleeping', async () => {
    let t = 0
    __setClockForTests(() => t)
    const { sleeper, calls } = makeFakeSleeper()
    __setSleeperForTests(sleeper)

    for (let i = 0; i < 60; i++) {
      await consume('u1')
    }

    expect(calls).toHaveLength(0)
  })

  it('61st call sleeps ~1000ms then resolves', async () => {
    let t = 0
    __setClockForTests(() => t)
    const { sleeper, calls } = makeFakeSleeper()
    __setSleeperForTests(sleeper)

    for (let i = 0; i < 60; i++) {
      await consume('u1')
    }

    await consume('u1')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toBeGreaterThanOrEqual(900)
    expect(calls[0]).toBeLessThanOrEqual(1100)
  })

  it('per-user isolation: u2 bucket is independent of u1', async () => {
    let t = 0
    __setClockForTests(() => t)
    const { sleeper, calls } = makeFakeSleeper()
    __setSleeperForTests(sleeper)

    for (let i = 0; i < 60; i++) {
      await consume('u1')
    }

    await consume('u2')
    expect(calls).toHaveLength(0)
  })

  it('throws RateLimitExceededError when wait would exceed maxWaitMs', async () => {
    let t = 0
    __setClockForTests(() => t)
    // capacity=1, refillPerMinute=1 → 1 token/min → next token in 60_000ms
    // maxWaitMs=100 → 60_000 > 100 → throw immediately
    __setOptsForTests({ capacity: 1, refillPerMinute: 1, maxWaitMs: 100 })
    const { sleeper } = makeFakeSleeper()
    __setSleeperForTests(sleeper)

    await consume('u-limited') // uses the 1 token

    await expect(consume('u-limited')).rejects.toThrow(RateLimitExceededError)
  })

  it('refill over time: consume 60, advance clock 30s, next consume returns immediately', async () => {
    let t = 0
    __setClockForTests(() => t)
    const { sleeper, calls } = makeFakeSleeper()
    __setSleeperForTests(sleeper)

    for (let i = 0; i < 60; i++) {
      await consume('u1')
    }

    t = 30_000

    await consume('u1')
    expect(calls).toHaveLength(0)
  })

  it('AC-18: 60 rapid calls drain bucket; 5 more cause sleeper to be called', async () => {
    let t = 0
    __setClockForTests(() => t)
    const { sleeper, calls } = makeFakeSleeper()
    __setSleeperForTests(sleeper)

    for (let i = 0; i < 60; i++) {
      await consume('user-a')
    }

    for (let i = 0; i < 5; i++) {
      await consume('user-a')
    }

    expect(calls.length).toBeGreaterThanOrEqual(1)
  })
})
