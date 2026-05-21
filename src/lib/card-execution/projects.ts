/** Board-name slugification and ClaudeMCP project registry cache. */

const CACHE_TTL_MS = 60_000

type ListProjectsFn = () => Promise<string[]>

let cachedProjects: string[] | null = null
let cacheExpiresAt = 0
let testOverride: ListProjectsFn | null = null

export function slugifyBoardName(name: string): string {
  return name
    .replace(/[^\x00-\x7F]/g, '')   // strip non-ASCII before regex pass
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')    // runs of non-alphanumeric → single hyphen
    .replace(/^-+|-+$/g, '')        // trim leading/trailing hyphens
}

async function resolveListProjects(): Promise<ListProjectsFn> {
  if (testOverride !== null) return testOverride
  const mod = await import('./mcp-client')
  return (mod as { listClaudeProjects: ListProjectsFn }).listClaudeProjects
}

export async function isProjectRegistered(slug: string): Promise<boolean> {
  if (cachedProjects === null || Date.now() >= cacheExpiresAt) {
    const listProjects = await resolveListProjects()
    cachedProjects = await listProjects()
    cacheExpiresAt = Date.now() + CACHE_TTL_MS
  }
  return cachedProjects.includes(slug)
}

export function resetProjectCacheForTests(): void {
  cachedProjects = null
  cacheExpiresAt = 0
}

export function __setListProjectsForTests(fn: ListProjectsFn | null): void {
  testOverride = fn
}
