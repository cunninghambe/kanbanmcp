/**
 * The single network seam for Slack (spec §4.8). Both `oauth.ts` and
 * `client.ts` call through here, so neither has to import the other and tests
 * can stub every Slack request in one place.
 */

export type SlackFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  status: number
  ok: boolean
  headers?: { get(name: string): string | null }
  text: () => Promise<string>
  json: () => Promise<unknown>
}>

let stub: SlackFetch | null = null

const defaultSleeper = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
let sleeper: (ms: number) => Promise<void> = defaultSleeper

/** Performs a Slack HTTP call — the global fetch unless a test stub is installed. */
export function slackFetch(url: string, init?: Parameters<SlackFetch>[1]): ReturnType<SlackFetch> {
  if (stub) return stub(url, init)
  return fetch(url, init) as ReturnType<SlackFetch>
}

/** Used by the client's 429 back-off; overridable so tests never really wait. */
export function slackSleep(ms: number): Promise<void> {
  return sleeper(ms)
}

/** Test seam: replaces every Slack HTTP call. Pass null to restore. */
export function __setSlackFetchForTests(mock: SlackFetch | null): void {
  stub = mock
}

/** Test seam: replaces the back-off sleeper. Pass null to restore. */
export function __setSlackSleeperForTests(s: ((ms: number) => Promise<void>) | null): void {
  sleeper = s ?? defaultSleeper
}
