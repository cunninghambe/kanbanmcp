/**
 * Tests for board API routes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session ────────────────────────────────────────────────────────
const mockSession = {
  userId: 'user-1',
  orgId: 'org-1',
  save: vi.fn(),
}

vi.mock('iron-session', () => ({
  getIronSession: vi.fn().mockResolvedValue(mockSession),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockReturnValue({}),
}))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  board: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  column: {
    create: vi.fn(),
  },
  orgMember: {
    findUnique: vi.fn(),
  },
  organization: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
}

vi.mock('../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

// ─── Mock claude-mcp-registry ─────────────────────────────────────────────────
const mockEnsureProjectDirectory = vi.fn()
const mockUpsertProject = vi.fn()
const mockReloadClaudeMcp = vi.fn()

vi.mock('../src/lib/claude-mcp-registry', () => ({
  ensureProjectDirectory: (...args: unknown[]) => mockEnsureProjectDirectory(...args),
  upsertProject: (...args: unknown[]) => mockUpsertProject(...args),
  reloadClaudeMcp: (...args: unknown[]) => mockReloadClaudeMcp(...args),
  readRegistry: vi.fn().mockResolvedValue({}),
  writeRegistry: vi.fn(),
  __setProjectsJsonPathForTests: vi.fn(),
  PROJECTS_JSON_PATH: '/tmp/test-projects.json',
  CLAUDE_MCP_PROCESS_NAME: 'claude-mcp',
}))

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── GET /api/boards/[boardId] ────────────────────────────────────────────────
describe('GET /api/boards/[boardId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'ADMIN',
    })
  })

  it('returns 401 when not authenticated', async () => {
    const { getIronSession } = await import('iron-session')
    vi.mocked(getIronSession).mockResolvedValueOnce({
      userId: '',
      orgId: '',
      save: vi.fn(),
    } as never)
    const { GET } = await import('../src/app/api/boards/[boardId]/route')
    const req = makeRequest('http://localhost/api/boards/board-1', 'GET')
    const res = await GET(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when board not found', async () => {
    mockPrisma.board.findUnique.mockResolvedValue(null)
    const { GET } = await import('../src/app/api/boards/[boardId]/route')
    const req = makeRequest('http://localhost/api/boards/nonexistent', 'GET')
    const res = await GET(req, { params: Promise.resolve({ boardId: 'nonexistent' }) })
    expect(res.status).toBe(404)
  })

  it('returns 404 when board belongs to different org', async () => {
    mockPrisma.board.findUnique.mockResolvedValue({
      id: 'board-1',
      orgId: 'other-org',
      name: 'Other Board',
    })
    const { GET } = await import('../src/app/api/boards/[boardId]/route')
    const req = makeRequest('http://localhost/api/boards/board-1', 'GET')
    const res = await GET(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns board with columns and cards', async () => {
    const boardData = {
      id: 'board-1',
      orgId: 'org-1',
      name: 'My Board',
      columns: [{ id: 'col-1', name: 'Backlog', position: 0, cards: [] }],
    }
    // First call: resolveBoard check
    mockPrisma.board.findUnique.mockResolvedValueOnce({ id: 'board-1', orgId: 'org-1' })
    // Second call: full board fetch
    mockPrisma.board.findUnique.mockResolvedValueOnce(boardData)

    const { GET } = await import('../src/app/api/boards/[boardId]/route')
    const req = makeRequest('http://localhost/api/boards/board-1', 'GET')
    const res = await GET(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.board.id).toBe('board-1')
    expect(body.board.name).toBe('My Board')
  })
})

// ─── PATCH /api/boards/[boardId] ──────────────────────────────────────────────
describe('PATCH /api/boards/[boardId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'ADMIN',
    })
  })

  it('returns 400 for empty board name', async () => {
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    const { PATCH } = await import('../src/app/api/boards/[boardId]/route')
    const req = makeRequest('http://localhost/api/boards/board-1', 'PATCH', { name: '' })
    const res = await PATCH(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(400)
  })

  it('updates board name successfully', async () => {
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    mockPrisma.board.update.mockResolvedValue({ id: 'board-1', orgId: 'org-1', name: 'New Name' })
    const { PATCH } = await import('../src/app/api/boards/[boardId]/route')
    const req = makeRequest('http://localhost/api/boards/board-1', 'PATCH', { name: 'New Name' })
    const res = await PATCH(req, { params: Promise.resolve({ boardId: 'board-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.board.name).toBe('New Name')
  })
})

// ─── GET /api/orgs/[orgId]/boards ─────────────────────────────────────────────
describe('GET /api/orgs/[orgId]/boards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
  })

  it('returns list of boards with counts', async () => {
    mockPrisma.board.findMany.mockResolvedValue([
      {
        id: 'board-1',
        orgId: 'org-1',
        name: 'Sprint Board',
        createdAt: new Date(),
        _count: { columns: 4, cards: 12 },
      },
    ])
    const { GET } = await import('../src/app/api/orgs/[orgId]/boards/route')
    const req = makeRequest('http://localhost/api/orgs/org-1/boards', 'GET')
    const res = await GET(req, { params: Promise.resolve({ orgId: 'org-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.boards[0].columnCount).toBe(4)
    expect(body.boards[0].cardCount).toBe(12)
  })
})

// ─── POST /api/orgs/[orgId]/boards ────────────────────────────────────────────
describe('POST /api/orgs/[orgId]/boards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'ADMIN',
    })
  })

  it('returns 400 for empty board name', async () => {
    const { POST } = await import('../src/app/api/orgs/[orgId]/boards/route')
    const req = makeRequest('http://localhost/api/orgs/org-1/boards', 'POST', { name: '' })
    const res = await POST(req, { params: Promise.resolve({ orgId: 'org-1' }) })
    expect(res.status).toBe(400)
  })

  it('returns 404 when org not found', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null)
    const { POST } = await import('../src/app/api/orgs/[orgId]/boards/route')
    const req = makeRequest('http://localhost/api/orgs/org-1/boards', 'POST', { name: 'New Board' })
    const res = await POST(req, { params: Promise.resolve({ orgId: 'org-1' }) })
    expect(res.status).toBe(404)
  })

  it('creates board with default columns (201)', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Test Org' })
    const newBoard = { id: 'board-2', orgId: 'org-1', name: 'New Board', createdAt: new Date() }
    const columns = [
      { id: 'col-1', name: 'Backlog', position: 0, boardId: 'board-2' },
      { id: 'col-2', name: 'In Progress', position: 1, boardId: 'board-2' },
      { id: 'col-3', name: 'Review', position: 2, boardId: 'board-2' },
      { id: 'col-4', name: 'Done', position: 3, boardId: 'board-2' },
    ]
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          board: { create: vi.fn().mockResolvedValue(newBoard) },
          column: {
            create: vi
              .fn()
              .mockImplementation(({ data }: { data: { name: string; position: number } }) =>
                Promise.resolve({ id: `col-${data.position}`, ...data, boardId: 'board-2' })
              ),
          },
        } as unknown as typeof mockPrisma)
      }
    )
    const { POST } = await import('../src/app/api/orgs/[orgId]/boards/route')
    const req = makeRequest('http://localhost/api/orgs/org-1/boards', 'POST', { name: 'New Board' })
    const res = await POST(req, { params: Promise.resolve({ orgId: 'org-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.board.name).toBe('New Board')
    expect(Array.isArray(body.columns)).toBe(true)
  })

  it('creates exactly 5 columns in canonical order: Backlog(0), In Progress(1), Review(2), Blocked(3), Done(4)', async () => {
    // Given — org exists, transaction mock captures column.create calls
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Test Org' })
    const newBoard = { id: 'board-2', orgId: 'org-1', name: 'AC10 Board', createdAt: new Date() }
    const columnCreateSpy = vi.fn().mockImplementation(
      ({ data }: { data: { name: string; position: number } }) =>
        Promise.resolve({ id: `col-${data.position}`, ...data, boardId: 'board-2' })
    )
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) =>
        fn({ board: { create: vi.fn().mockResolvedValue(newBoard) }, column: { create: columnCreateSpy } } as unknown as typeof mockPrisma)
    )

    // When
    const { POST } = await import('../src/app/api/orgs/[orgId]/boards/route')
    const req = makeRequest('http://localhost/api/orgs/org-1/boards', 'POST', { name: 'AC10 Board' })
    const res = await POST(req, { params: Promise.resolve({ orgId: 'org-1' }) })

    // Then — response is 201 with exactly 5 columns in canonical order
    expect(res.status).toBe(201)
    const body = await res.json() as { board: { name: string }; columns: { name: string; position: number }[] }
    expect(body.columns).toHaveLength(5)
    expect(body.columns[0]).toMatchObject({ name: 'Backlog', position: 0 })
    expect(body.columns[1]).toMatchObject({ name: 'In Progress', position: 1 })
    expect(body.columns[2]).toMatchObject({ name: 'Review', position: 2 })
    expect(body.columns[3]).toMatchObject({ name: 'Blocked', position: 3 })
    expect(body.columns[4]).toMatchObject({ name: 'Done', position: 4 })
  })

  it('returns 403 when user lacks ADMIN role', async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      orgId: 'org-1',
      role: 'MEMBER',
    })
    const { POST } = await import('../src/app/api/orgs/[orgId]/boards/route')
    const req = makeRequest('http://localhost/api/orgs/org-1/boards', 'POST', { name: 'New Board' })
    const res = await POST(req, { params: Promise.resolve({ orgId: 'org-1' }) })
    expect(res.status).toBe(403)
  })

  it('POST with repoPath calls registry helpers and returns claudeRegistration: ok:true', async () => {
    mockEnsureProjectDirectory.mockResolvedValue(undefined)
    mockUpsertProject.mockResolvedValue(undefined)
    mockReloadClaudeMcp.mockResolvedValue(undefined)
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Test Org' })
    const newBoard = { id: 'board-3', orgId: 'org-1', name: 'Claude Board', createdAt: new Date() }
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) =>
        fn({
          board: { create: vi.fn().mockResolvedValue(newBoard) },
          column: {
            create: vi.fn().mockImplementation(
              ({ data }: { data: { name: string; position: number } }) =>
                Promise.resolve({ id: `col-${data.position}`, ...data, boardId: 'board-3' })
            ),
          },
        } as unknown as typeof mockPrisma)
    )

    const { POST } = await import('../src/app/api/orgs/[orgId]/boards/route')
    const req = makeRequest('http://localhost/api/orgs/org-1/boards', 'POST', {
      name: 'Claude Board',
      repoPath: '/opt/claude-board',
    })
    const res = await POST(req, { params: Promise.resolve({ orgId: 'org-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json() as {
      board: { name: string }
      claudeRegistration: { ok: boolean; project: string; path: string }
    }
    expect(body.board.name).toBe('Claude Board')
    expect(body.claudeRegistration).toEqual({ ok: true, project: 'claude-board', path: '/opt/claude-board' })
    expect(mockEnsureProjectDirectory).toHaveBeenCalledWith('/opt/claude-board', 'main')
    expect(mockUpsertProject).toHaveBeenCalledWith('claude-board', '/opt/claude-board', 'main')
    expect(mockReloadClaudeMcp).toHaveBeenCalled()
  })

  it('POST without repoPath returns NO claudeRegistration field', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Test Org' })
    const newBoard = { id: 'board-4', orgId: 'org-1', name: 'Plain Board', createdAt: new Date() }
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) =>
        fn({
          board: { create: vi.fn().mockResolvedValue(newBoard) },
          column: {
            create: vi.fn().mockImplementation(
              ({ data }: { data: { name: string; position: number } }) =>
                Promise.resolve({ id: `col-${data.position}`, ...data, boardId: 'board-4' })
            ),
          },
        } as unknown as typeof mockPrisma)
    )

    const { POST } = await import('../src/app/api/orgs/[orgId]/boards/route')
    const req = makeRequest('http://localhost/api/orgs/org-1/boards', 'POST', { name: 'Plain Board' })
    const res = await POST(req, { params: Promise.resolve({ orgId: 'org-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(body.board).toBeDefined()
    expect('claudeRegistration' in body).toBe(false)
  })

  it('POST with repoPath that throws during registration returns claudeRegistration:ok:false but still creates board', async () => {
    mockEnsureProjectDirectory.mockRejectedValue(new Error('git init failed'))
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Test Org' })
    const newBoard = { id: 'board-5', orgId: 'org-1', name: 'Fail Board', createdAt: new Date() }
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) =>
        fn({
          board: { create: vi.fn().mockResolvedValue(newBoard) },
          column: {
            create: vi.fn().mockImplementation(
              ({ data }: { data: { name: string; position: number } }) =>
                Promise.resolve({ id: `col-${data.position}`, ...data, boardId: 'board-5' })
            ),
          },
        } as unknown as typeof mockPrisma)
    )

    const { POST } = await import('../src/app/api/orgs/[orgId]/boards/route')
    const req = makeRequest('http://localhost/api/orgs/org-1/boards', 'POST', {
      name: 'Fail Board',
      repoPath: '/opt/fail-board',
    })
    const res = await POST(req, { params: Promise.resolve({ orgId: 'org-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json() as {
      board: { name: string }
      claudeRegistration: { ok: boolean; error: string }
    }
    expect(body.board).toBeDefined()
    expect(body.claudeRegistration.ok).toBe(false)
    // The route returns a generic message and logs the raw error server-side,
    // so internal git/filesystem details are not leaked to the client.
    expect(body.claudeRegistration.error).toBe('Claude project registration failed')
    expect(body.claudeRegistration.error).not.toContain('git init failed')
  })
})
