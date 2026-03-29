'use client'

import useSWR from 'swr'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

export function useSession() {
  const { data, error, isLoading, mutate } = useSWR('/api/auth/me', fetcher, {
    revalidateOnFocus: false,
  })

  return {
    user: data?.user ?? null,
    org: data?.orgMemberships?.[0]?.org ?? null,
    orgMemberships: data?.orgMemberships ?? [],
    isLoading,
    isError: !!error,
    mutate,
  }
}
