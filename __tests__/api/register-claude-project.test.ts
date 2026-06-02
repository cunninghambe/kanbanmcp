/**
 * Tests for POST /api/boards/[boardId]/register-claude-project
 *
 * Covers the error-leak hardening fix: when registration throws (e.g. a git /
 * filesystem error), the client must receive a generic 500 message — NOT the
 * raw Error.message which can disclose server paths and git internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session ────────────────────────────────────────────────────────
const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockResolvedValue({}) }))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  board: { findUnique: vi.fn() },
  orgMember: { findUnique: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

// ─── Mock claude-mcp-registry ─────────────────────────────────────────────────
const mockEnsureProjectDirectory = vi.fn()
const mockUpsertProject = vi.fn()
const mockReloadClaudeMcp = vi.fn()
vi.mock('../../src/lib/claude-mcp-registry', () => ({
  ensureProjectDirectory: (...args: unknown[]) => mockEnsureProjectDirectory(...args),
  upsertProject: (...args: unknown[]) => mockUpsertProject(...args),
  reloadClaudeMcp: (...args: unknown[]) => mockReloadClaudeMcp(...args),
}))

const BOARD = { id: 'board-1', orgId: 'org-1', name: 'My Board' }

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/boards/board-1/register-claude-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ctx = { params: Promise.resolve({ boardId: 'board-1' }) }

async function getPOST() {
  const mod = await import('../../src/app/api/boards/[boardId]/register-claude-project/route')
  return mod.POST as typeof mod.POST
}

describe('POST /api/boards/[boardId]/register-claude-project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.board.findUnique.mockResolvedValue(BOARD)
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'ADMIN' })
    mockEnsureProjectDirectory.mockResolvedValue(undefined)
    mockUpsertProject.mockResolvedValue(undefined)
    mockReloadClaudeMcp.mockResolvedValue(undefined)
  })

  it('returns 200 and the slug on success (negative / false-positive boundary)', async () => {
    const POST = await getPOST()
    const res = await POST(makeRequest({ repoPath: '/opt/my-board' }), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.project).toBe('my-board')
  })

  it('returns a GENERIC 500 (no raw error.message) when registration throws', async () => {
    // Raw message contains a server filesystem path + git detail that must not leak.
    const secretLeak = "fatal: cannot init /root/secret-repo/.git: permission denied"
    mockEnsureProjectDirectory.mockRejectedValue(new Error(secretLeak))

    const POST = await getPOST()
    const res = await POST(makeRequest({ repoPath: '/opt/my-board' }), ctx)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Internal server error')
    // The raw filesystem / git detail must NOT appear in the client response.
    expect(JSON.stringify(body)).not.toContain('/root/secret-repo')
    expect(JSON.stringify(body)).not.toContain('permission denied')
  })

  it('returns 500 generic on upsertProject failure (edge case)', async () => {
    mockUpsertProject.mockRejectedValue(new Error('/var/lib/projects.json write EACCES'))
    const POST = await getPOST()
    const res = await POST(makeRequest({ repoPath: '/opt/my-board' }), ctx)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Internal server error')
    expect(JSON.stringify(body)).not.toContain('/var/lib')
  })

  it('still returns 404 for a board outside the caller org (auth path unchanged)', async () => {
    mockPrisma.board.findUnique.mockResolvedValue({ ...BOARD, orgId: 'other-org' })
    const POST = await getPOST()
    const res = await POST(makeRequest({ repoPath: '/opt/my-board' }), ctx)
    expect(res.status).toBe(404)
  })
})
