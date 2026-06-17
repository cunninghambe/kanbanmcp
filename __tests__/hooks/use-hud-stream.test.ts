// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('swr', () => ({ mutate: vi.fn() }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  url: string
  readyState = FakeEventSource.CONNECTING
  onerror: ((e: unknown) => void) | null = null
  onopen: ((e: unknown) => void) | null = null
  listeners: Record<string, ((e: unknown) => void)[]> = {}
  closed = false
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this) }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ||= []).push(fn) }
  removeEventListener() {}
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED }
  emitError() { this.readyState = FakeEventSource.CLOSED; this.onerror?.({}) }
}

beforeEach(() => {
  FakeEventSource.instances = []
  // @ts-expect-error test shim
  globalThis.EventSource = FakeEventSource
})

describe('useHudStream', () => {
  it('does not open a stream when disabled (no live session)', async () => {
    const { useHudStream } = await import('../../src/hooks/useHudStream')
    renderHook(() => useHudStream({ sessionId: 'hud-1', enabled: false }))
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('stops reconnecting after the error cap is reached', async () => {
    const { useHudStream } = await import('../../src/hooks/useHudStream')
    renderHook(() => useHudStream({ sessionId: 'hud-1', enabled: true }))
    const es = FakeEventSource.instances[0]
    expect(es).toBeTruthy()
    for (let i = 0; i < 6; i++) es.emitError()
    expect(es.closed).toBe(true)
  })
})
