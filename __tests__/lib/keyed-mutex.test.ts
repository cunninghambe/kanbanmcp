/**
 * Unit tests for src/lib/keyed-mutex.ts
 *
 * Contract:
 *  - Callbacks sharing the same key run strictly serially (never interleave).
 *  - Callbacks with different keys run concurrently.
 *  - The per-key map entry is cleaned up once a key's chain drains.
 *  - A rejecting callback does not poison the chain for later callers.
 */
import { describe, it, expect } from 'vitest'
import { withKeyedLock, __activeKeyCountForTests } from '../../src/lib/keyed-mutex'

// A controllable deferred so we can hold a critical section open across awaits.
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withKeyedLock', () => {
  it('POSITIVE: same-key callbacks run serially and never interleave', async () => {
    const events: string[] = []

    const makeJob = (label: string) => async () => {
      events.push(`${label}:start`)
      // Yield to the event loop several times; if locking is broken the other
      // job would interleave here.
      await Promise.resolve()
      await Promise.resolve()
      events.push(`${label}:end`)
    }

    const p1 = withKeyedLock('k', makeJob('A'))
    const p2 = withKeyedLock('k', makeJob('B'))
    await Promise.all([p1, p2])

    // A must fully complete before B starts.
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('POSITIVE: serialized check-then-create — only the first caller "creates"', async () => {
    let created = 0
    let exists = false

    const job = async () => {
      // Non-atomic read-then-write that is only safe under the lock.
      if (!exists) {
        await Promise.resolve() // simulate async work between check and write
        exists = true
        created += 1
        return true
      }
      return false
    }

    const results = await Promise.all([
      withKeyedLock('dedup', job),
      withKeyedLock('dedup', job),
      withKeyedLock('dedup', job),
    ])

    expect(created).toBe(1)
    expect(results).toEqual([true, false, false])
  })

  it('NEGATIVE boundary: different keys are NOT blocked — they run concurrently', async () => {
    const gateA = deferred<void>()
    const order: string[] = []

    // Job A on key "a" parks until we release the gate.
    const pA = withKeyedLock('a', async () => {
      order.push('a:start')
      await gateA.promise
      order.push('a:end')
    })

    // Job B on key "b" must be able to start and finish while A is still parked,
    // proving different keys do not serialize.
    const pB = withKeyedLock('b', async () => {
      order.push('b:start')
      order.push('b:end')
    })

    await pB
    expect(order).toEqual(['a:start', 'b:start', 'b:end'])

    gateA.resolve()
    await pA
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end'])
  })

  it('EDGE: map drains to zero keys once all chains settle', async () => {
    await Promise.all([
      withKeyedLock('x', async () => undefined),
      withKeyedLock('x', async () => undefined),
      withKeyedLock('y', async () => undefined),
    ])
    expect(__activeKeyCountForTests()).toBe(0)
  })

  it('EDGE: a rejecting callback does not poison the chain for later callers', async () => {
    const order: string[] = []

    const failing = withKeyedLock('shared', async () => {
      order.push('fail')
      throw new Error('boom')
    })
    const following = withKeyedLock('shared', async () => {
      order.push('ok')
      return 42
    })

    await expect(failing).rejects.toThrow('boom')
    await expect(following).resolves.toBe(42)
    // The failing job ran first and the follower still ran afterwards, in order.
    expect(order).toEqual(['fail', 'ok'])
    // And the map still cleaned up afterwards.
    expect(__activeKeyCountForTests()).toBe(0)
  })

  it('EDGE: each caller observes its own return value (no cross-talk)', async () => {
    const r1 = await withKeyedLock('ret', async () => 'first')
    const r2 = await withKeyedLock('ret', async () => 'second')
    expect(r1).toBe('first')
    expect(r2).toBe('second')
    expect(__activeKeyCountForTests()).toBe(0)
  })
})
