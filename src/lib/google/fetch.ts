export type GoogleFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string>; json: () => Promise<unknown>; arrayBuffer?: () => Promise<ArrayBufferLike> }>

let impl: GoogleFetch | null = null

export function googleFetch(...args: Parameters<GoogleFetch>): ReturnType<GoogleFetch> {
  if (impl) return impl(...args)
  return fetch(args[0], args[1]) as ReturnType<GoogleFetch>
}

export function __setGoogleFetchForTests(mock: GoogleFetch | null): void {
  impl = mock
}
