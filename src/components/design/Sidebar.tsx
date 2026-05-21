'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import useSWR from 'swr'
import { useState } from 'react'
import {
  LayoutDashboard,
  LifeBuoy,
  Activity,
  Settings2,
  LogOut,
  Plus,
} from 'lucide-react'
import { useSession } from '@/hooks/useSession'
import { Wordmark } from './Wordmark'
import { Avatar } from './Avatar'
import { ThemeToggle } from './ThemeToggle'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

type Board = { id: string; name: string }

/**
 * App sidebar — 240px fixed column with brand, board list (live fetch),
 * manage nav, MCP status block, and user footer.
 * Does not manage global state; reads session + boards from SWR.
 */
export function DesignSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { user, org } = useSession()

  const { data: boardsData, mutate: mutateBoards } = useSWR(
    org ? `/api/orgs/${org.id}/boards` : null,
    fetcher
  )
  const boards: Board[] = boardsData?.boards ?? boardsData ?? []

  const [creatingBoard, setCreatingBoard] = useState(false)
  const [newBoardName, setNewBoardName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')

  async function handleCreateBoard(e: React.FormEvent) {
    e.preventDefault()
    const name = newBoardName.trim()
    if (!name || !org) return
    setSubmitting(true)
    setCreateError(null)
    try {
      const res = await fetch(`/api/orgs/${org.id}/boards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setCreateError(body.error ?? res.statusText)
        return
      }
      const { board } = (await res.json()) as { board: { id: string } }
      setNewBoardName('')
      setCreatingBoard(false)
      mutateBoards()
      router.push(`/board/${board.id}`)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create board')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  const itemBase: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
    letterSpacing: '-0.005em',
    textDecoration: 'none',
    transition: `background var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out)`,
  }

  function navStyle(active: boolean): React.CSSProperties {
    return {
      ...itemBase,
      color: active ? 'var(--fg-0)' : 'var(--fg-2)',
      background: active ? 'var(--bg-2)' : 'transparent',
      borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
    }
  }

  return (
    <aside
      style={{
        width: 240,
        background: 'var(--bg-1)',
        borderRight: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        minHeight: '100vh',
      }}
    >
      {/* Brand */}
      <div style={{ padding: '16px 16px 14px', borderBottom: '1px solid var(--line)' }}>
        <Wordmark size={15} />
        {org && (
          <div
            className="km-eyebrow"
            style={{ marginTop: 8, fontSize: 9, color: 'var(--fg-3)' }}
          >
            org / {org.name.toLowerCase()}
            {' '}·{' '}
            <span style={{ color: 'var(--ok)' }}>● connected</span>
          </div>
        )}
      </div>

      {/* Top nav */}
      <div style={{ padding: '10px 0 6px' }}>
        <Link href="/dashboard" style={navStyle(pathname === '/dashboard')}>
          <LayoutDashboard size={14} />
          <span style={{ flex: 1 }}>dashboard</span>
        </Link>
      </div>

      {/* Boards section */}
      <div
        style={{
          padding: '10px 16px 6px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
          [01] // boards
        </div>
        <button
          type="button"
          onClick={() => {
            setCreatingBoard((v) => !v)
            setCreateError(null)
          }}
          aria-label={creatingBoard ? 'Cancel new board' : 'New board'}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 4px',
            color: 'var(--fg-3)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Plus size={13} />
        </button>
      </div>
      {creatingBoard && (
        <form
          onSubmit={handleCreateBoard}
          style={{ padding: '4px 16px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <input
            type="text"
            autoFocus
            placeholder="board name…"
            value={newBoardName}
            onChange={(e) => setNewBoardName(e.target.value)}
            className="km-input"
            style={{ fontSize: 12, height: 28 }}
            aria-label="New board name"
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="submit"
              disabled={submitting || !newBoardName.trim()}
              className="km-btn km-btn--primary km-btn--sm"
              style={{ flex: 1 }}
            >
              {submitting ? 'creating…' : 'create'}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreatingBoard(false)
                setNewBoardName('')
                setCreateError(null)
              }}
              className="km-btn km-btn--ghost km-btn--sm"
            >
              cancel
            </button>
          </div>
          {createError && (
            <div
              className="km-mono"
              style={{ fontSize: 10, color: 'var(--err)', letterSpacing: '0.04em' }}
              role="alert"
            >
              {createError}
            </div>
          )}
        </form>
      )}
      <div style={{ paddingBottom: 6 }}>
        {boards.map((b) => {
          const active = pathname.startsWith(`/board/${b.id}`)
          return (
            <Link key={b.id} href={`/board/${b.id}`} style={navStyle(active)}>
              <span
                className="km-mono"
                style={{ fontSize: 10, color: 'var(--fg-3)', width: 14, flexShrink: 0 }}
              >
                {active ? '▸' : '·'}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {b.name.toLowerCase()}
              </span>
            </Link>
          )
        })}
        {boards.length === 0 && (
          <div
            className="km-mono"
            style={{ padding: '4px 14px', fontSize: 11, color: 'var(--fg-3)' }}
          >
            no boards
          </div>
        )}
      </div>

      {/* Manage section */}
      <div style={{ padding: '16px 16px 6px' }}>
        <div className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
          [02] // manage
        </div>
      </div>
      <div>
        <Link href="/helpdesk" style={navStyle(isActive('/helpdesk'))}>
          <LifeBuoy size={14} />
          <span style={{ flex: 1 }}>helpdesk</span>
        </Link>
        <Link href="/activity" style={navStyle(isActive('/activity'))}>
          <Activity size={14} />
          <span style={{ flex: 1 }}>activity</span>
        </Link>
        <Link href="/settings" style={navStyle(isActive('/settings'))}>
          <Settings2 size={14} />
          <span style={{ flex: 1 }}>settings</span>
        </Link>
      </div>

      {/* MCP status + user footer */}
      <div
        style={{
          marginTop: 'auto',
          padding: 16,
          borderTop: '1px solid var(--line)',
          background: 'var(--bg-2)',
        }}
      >
        <div className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)', marginBottom: 6 }}>
          mcp endpoint
        </div>
        <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-1)', lineHeight: 1.4 }}>
          /api/mcp
        </div>
        <div className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>
          <span style={{ color: 'var(--ok)' }}>● live</span>
        </div>

        <div className="km-hr" style={{ margin: '10px 0' }} />

        <ThemeToggle />

        <div className="km-hr" style={{ margin: '10px 0' }} />

        {user ? (
          <div className="flex items-center gap-2">
            <Avatar name={user.name ?? ''} size="sm" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, color: 'var(--fg-1)', letterSpacing: '-0.005em' }}>
                {(user.name ?? '').toLowerCase()}
              </div>
              <div className="km-mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
                MEMBER
              </div>
            </div>
            <button
              onClick={handleLogout}
              aria-label="Sign out"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                color: 'var(--fg-3)',
                display: 'flex',
              }}
            >
              <LogOut size={13} />
            </button>
          </div>
        ) : (
          <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>not signed in</div>
        )}
      </div>
    </aside>
  )
}
