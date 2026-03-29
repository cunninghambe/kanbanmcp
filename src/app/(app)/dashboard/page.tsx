'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { useSession } from '@/hooks/useSession'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export default function DashboardPage() {
  const router = useRouter()
  const { org } = useSession()
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [newBoardName, setNewBoardName] = useState('')
  const [creating, setCreating] = useState(false)

  const { data, mutate } = useSWR(
    org ? `/api/orgs/${org.id}/boards` : null,
    fetcher
  )

  const boards = data?.boards ?? data ?? []

  async function handleCreateBoard(e: React.FormEvent) {
    e.preventDefault()
    if (!org || !newBoardName.trim()) return
    setCreating(true)
    try {
      const res = await fetch(`/api/orgs/${org.id}/boards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newBoardName.trim() }),
      })
      if (res.ok) {
        const board = await res.json()
        setShowNewBoard(false)
        setNewBoardName('')
        mutate()
        router.push(`/board/${board.id ?? board.board?.id}`)
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Header title="Dashboard" />
      <main className="flex-1 p-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold text-slate-900">Your Boards</h1>
            <Button onClick={() => setShowNewBoard(true)}>New Board</Button>
          </div>

          {boards.length === 0 ? (
            <div className="text-center py-16 text-slate-500">
              <p className="text-lg mb-4">No boards yet</p>
              <Button onClick={() => setShowNewBoard(true)}>Create your first board</Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {boards.map((board: {
                id: string
                name: string
                columnCount?: number
                cardCount?: number
                createdAt?: string
                updatedAt?: string
              }) => (
                <button
                  key={board.id}
                  onClick={() => router.push(`/board/${board.id}`)}
                  className="bg-white rounded-lg border border-slate-200 p-5 text-left hover:border-blue-300 hover:shadow-md transition-all group"
                >
                  <h3 className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors mb-3">
                    {board.name}
                  </h3>
                  <div className="flex items-center gap-4 text-sm text-slate-500">
                    <span>{board.columnCount ?? 0} columns</span>
                    <span>{board.cardCount ?? 0} cards</span>
                  </div>
                  {(board.updatedAt ?? board.createdAt) && (
                    <p className="text-xs text-slate-400 mt-2">
                      Updated {new Date(board.updatedAt ?? board.createdAt!).toLocaleDateString()}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </main>

      <Modal
        open={showNewBoard}
        onClose={() => { setShowNewBoard(false); setNewBoardName('') }}
        title="New Board"
        size="sm"
      >
        <form onSubmit={handleCreateBoard} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Board Name
            </label>
            <input
              type="text"
              value={newBoardName}
              onChange={(e) => setNewBoardName(e.target.value)}
              placeholder="e.g. Product Roadmap"
              autoFocus
              required
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setShowNewBoard(false); setNewBoardName('') }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !newBoardName.trim()}>
              {creating ? 'Creating…' : 'Create Board'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  )
}
