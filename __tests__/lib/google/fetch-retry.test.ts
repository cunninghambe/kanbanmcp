import { describe, it, expect, beforeEach } from 'vitest'
import {
  googleFetch,
  __setGoogleFetchForTests,
  __setRawFetchForTests,
  __setFetchSleeperForTests,
} from '../../../src/lib/google/fetch'
import { __resetBucketsForTests } from '../../../src/lib/google/rate-limit'

type FakeResponse = { status: number; ok: boolean; text: () => Promise<string>; json: () => Promise<unknown> }

function makeResponse(status: number, body = ''): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => ({}),
  }
}

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
  __setGoogleFetchForTests(null)
  __setRawFetchForTests(null)
  __resetBucketsForTests()
})

describe('googleFetch retry behaviour', () => {
  it('429 then 200: resolves on second attempt; sleeper called once with 1000ms', async () => {
    const { sleeper, calls } = makeFakeSleeper()
    __setFetchSleeperForTests(sleeper)

    const responses = [makeResponse(429), makeResponse(200)]
    let idx = 0
    __setRawFetchForTests(async () => responses[idx++])

    const res = await googleFetch('https://example.com', undefined, { retry: true })
    expect(res.status).toBe(200)
    expect(calls).toEqual([1000])
  })

  it('500, 500, 200: resolves on third attempt; sleeper called with 1000ms then 4000ms', async () => {
    const { sleeper, calls } = makeFakeSleeper()
    __setFetchSleeperForTests(sleeper)

    const responses = [makeResponse(500), makeResponse(500), makeResponse(200)]
    let idx = 0
    __setRawFetchForTests(async () => responses[idx++])

    const res = await googleFetch('https://example.com', undefined, { retry: true })
    expect(res.status).toBe(200)
    expect(calls).toEqual([1000, 4000])
  })

  it('429, 429, 429: resolves to the third 429; sleeper called with 1000ms and 4000ms only', async () => {
    const { sleeper, calls } = makeFakeSleeper()
    __setFetchSleeperForTests(sleeper)

    __setRawFetchForTests(async () => makeResponse(429))

    const res = await googleFetch('https://example.com', undefined, { retry: true })
    expect(res.status).toBe(429)
    // 3 attempts → 2 backoffs between them (no sleep after the final attempt)
    expect(calls).toEqual([1000, 4000])
  })

  it('401: resolves immediately; sleeper not called', async () => {
    const { sleeper, calls } = makeFakeSleeper()
    __setFetchSleeperForTests(sleeper)

    __setRawFetchForTests(async () => makeResponse(401))

    const res = await googleFetch('https://example.com', undefined, { retry: true })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('404: resolves immediately; sleeper not called', async () => {
    const { sleeper, calls } = makeFakeSleeper()
    __setFetchSleeperForTests(sleeper)

    __setRawFetchForTests(async () => makeResponse(404))

    const res = await googleFetch('https://example.com', undefined, { retry: true })
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('403: resolves immediately; sleeper not called', async () => {
    const { sleeper, calls } = makeFakeSleeper()
    __setFetchSleeperForTests(sleeper)

    __setRawFetchForTests(async () => makeResponse(403))

    const res = await googleFetch('https://example.com', undefined, { retry: true })
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('network error (fetch throws) with retry: propagates on third throw', async () => {
    const { sleeper, calls } = makeFakeSleeper()
    __setFetchSleeperForTests(sleeper)

    __setRawFetchForTests(async () => { throw new TypeError('fetch failed') })

    await expect(
      googleFetch('https://example.com', undefined, { retry: true })
    ).rejects.toThrow('fetch failed')
    expect(calls).toEqual([1000, 4000])
  })

  it('network error then 200: resolves on second attempt', async () => {
    const { sleeper, calls } = makeFakeSleeper()
    __setFetchSleeperForTests(sleeper)

    let idx = 0
    __setRawFetchForTests(async () => {
      if (idx++ === 0) throw new TypeError('fetch failed')
      return makeResponse(200)
    })

    const res = await googleFetch('https://example.com', undefined, { retry: true })
    expect(res.status).toBe(200)
    expect(calls).toEqual([1000])
  })

  it('retry: false (default): no retry on 500', async () => {
    const { sleeper, calls } = makeFakeSleeper()
    __setFetchSleeperForTests(sleeper)

    __setRawFetchForTests(async () => makeResponse(500))

    const res = await googleFetch('https://example.com', undefined, { retry: false })
    expect(res.status).toBe(500)
    expect(calls).toHaveLength(0)
  })
})
