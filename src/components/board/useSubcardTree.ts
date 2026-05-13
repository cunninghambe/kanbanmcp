'use client'

import useSWR from 'swr'
import type { SubtreeNode } from '@/lib/tree'

export type SubcardTreeData = {
  root: SubtreeNode
  descendants: SubtreeNode[]
  truncated: boolean
}

const fetcher = (url: string): Promise<SubcardTreeData> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

export function useSubcardTree(
  cardId: string,
  depth: number = 3
): {
  data: SubcardTreeData | undefined
  isLoading: boolean
  error: Error | undefined
  refresh: () => Promise<void>
} {
  const { data, error, isLoading, mutate } = useSWR<SubcardTreeData>(
    [`subcard-tree`, cardId, depth],
    ([, id, d]: [string, string, number]) => fetcher(`/api/cards/${id}/children?depth=${d}`),
    { revalidateOnFocus: false }
  )

  async function refresh(): Promise<void> {
    await mutate()
  }

  return {
    data,
    isLoading,
    error: error as Error | undefined,
    refresh,
  }
}
