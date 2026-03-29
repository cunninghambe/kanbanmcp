'use client'

import { useParams } from 'next/navigation'
import useSWR from 'swr'
import { Header } from '@/components/layout/Header'
import { SprintView } from '@/components/sprint/SprintView'

const fetcher = (url: string) =>
  fetch(url)
    .then((r) => r.json())
    .then((json) => json.board ?? json)

export default function SprintsPage() {
  const params = useParams()
  const boardId = params.boardId as string

  const { data: boardData } = useSWR(
    boardId ? `/api/boards/${boardId}` : null,
    fetcher
  )

  const boardName = boardData?.name ?? 'Board'

  return (
    <>
      <Header
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: boardName, href: `/board/${boardId}` },
          { label: 'Sprints' },
        ]}
      />
      <main className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-4xl mx-auto">
          <SprintView boardId={boardId} />
        </div>
      </main>
    </>
  )
}
