'use client'

import useSWR from 'swr'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json() as Promise<{ projects: string[] }>
  })

export function useClaudeProjects() {
  const { data, mutate } = useSWR('/api/me/claude-projects', fetcher)
  return {
    projects: data?.projects ?? [],
    mutate,
  }
}
