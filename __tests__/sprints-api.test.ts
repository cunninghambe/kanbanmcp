/**
 * Tests for sprint API routes
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
  sprint: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  board: {
    findUnique: vi.fn(),
  },
  card: {
    updateMany: vi.fn(),
  },
  orgMember: {
    findUnique: vi.fn(),
  },
}

vi.mock('../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

const baseSprint = {
  id: 'sprint-1',
  name: 'Sprint 1',
  boardId: 'board-1',
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-01-14'),
  status: 'PLANNING',
  board: { orgId: 'org-1' },
}

// ─── GET /api/sprints ─────────────────────────────────────────────────────────
describe('GET /api/sprints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  it('returns 400 when boardId is missing', async () => {
    const { GET } = await import('../src/app/api/sprints/route')
    const req = makeRequest('http://localhost/api/sprints', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('boardId')
  })

  it('returns 404 when board not found', async () => {
    mockPrisma.board.findUnique.mockResolvedValue(null)
    const { GET } = await import('../src/app/api/sprints/route')
    const req = makeRequest('http://localhost/api/sprints?boardId=nonexistent', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(404)
  })

  it('returns 403 when board belongs to different org', async () => {
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'other-org' })
    const { GET } = await import('../src/app/api/sprints/route')
    const req = makeRequest('http://localhost/api/sprints?boardId=board-1', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(403)
  })

  it('returns list of sprints for the board', async () => {
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    mockPrisma.sprint.findMany.mockResolvedValue([baseSprint])
    const { GET } = await import('../src/app/api/sprints/route')
    const req = makeRequest('http://localhost/api/sprints?boardId=board-1', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sprints).toHaveLength(1)
    expect(body.sprints[0].name).toBe('Sprint 1')
  })
})

// ─── POST /api/sprints ────────────────────────────────────────────────────────
describe('POST /api/sprints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  it('returns 400 for missing name', async () => {
    const { POST } = await import('../src/app/api/sprints/route')
    const req = makeRequest('http://localhost/api/sprints', 'POST', {
      boardId: 'board-1',
      startDate: '2024-01-01T00:00:00Z',
      endDate: '2024-01-14T00:00:00Z',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid dates', async () => {
    const { POST } = await import('../src/app/api/sprints/route')
    const req = makeRequest('http://localhost/api/sprints', 'POST', {
      name: 'Sprint 1',
      boardId: 'board-1',
      startDate: 'not-a-date',
      endDate: '2024-01-14T00:00:00Z',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('creates sprint with PLANNING status (201)', async () => {
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    mockPrisma.sprint.create.mockResolvedValue({
      id: 'sprint-2',
      name: 'Sprint 2',
      boardId: 'board-1',
      startDate: new Date('2024-02-01'),
      endDate: new Date('2024-02-14'),
      status: 'PLANNING',
    })
    const { POST } = await import('../src/app/api/sprints/route')
    const req = makeRequest('http://localhost/api/sprints', 'POST', {
      name: 'Sprint 2',
      boardId: 'board-1',
      startDate: '2024-02-01T00:00:00Z',
      endDate: '2024-02-14T00:00:00Z',
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.sprint.status).toBe('PLANNING')
  })
})

// ─── GET /api/sprints/[sprintId] ──────────────────────────────────────────────
describe('GET /api/sprints/[sprintId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  it('returns 404 when sprint not found', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(null)
    const { GET } = await import('../src/app/api/sprints/[sprintId]/route')
    const req = makeRequest('http://localhost/api/sprints/nonexistent', 'GET')
    const res = await GET(req, { params: { sprintId: 'nonexistent' } })
    expect(res.status).toBe(404)
  })

  it('returns sprint data', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(baseSprint)
    const { GET } = await import('../src/app/api/sprints/[sprintId]/route')
    const req = makeRequest('http://localhost/api/sprints/sprint-1', 'GET')
    const res = await GET(req, { params: { sprintId: 'sprint-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sprint.id).toBe('sprint-1')
  })
})

// ─── PATCH /api/sprints/[sprintId] ────────────────────────────────────────────
describe('PATCH /api/sprints/[sprintId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  it('returns 400 when no fields provided', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(baseSprint)
    const { PATCH } = await import('../src/app/api/sprints/[sprintId]/route')
    const req = makeRequest('http://localhost/api/sprints/sprint-1', 'PATCH', {})
    const res = await PATCH(req, { params: { sprintId: 'sprint-1' } })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid status value', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(baseSprint)
    const { PATCH } = await import('../src/app/api/sprints/[sprintId]/route')
    const req = makeRequest('http://localhost/api/sprints/sprint-1', 'PATCH', {
      status: 'INVALID_STATUS',
    })
    const res = await PATCH(req, { params: { sprintId: 'sprint-1' } })
    expect(res.status).toBe(400)
  })

  it('updates sprint status to ACTIVE', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(baseSprint)
    mockPrisma.sprint.update.mockResolvedValue({ ...baseSprint, status: 'ACTIVE' })
    const { PATCH } = await import('../src/app/api/sprints/[sprintId]/route')
    const req = makeRequest('http://localhost/api/sprints/sprint-1', 'PATCH', {
      status: 'ACTIVE',
    })
    const res = await PATCH(req, { params: { sprintId: 'sprint-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sprint.status).toBe('ACTIVE')
  })

  it('updates sprint name', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(baseSprint)
    mockPrisma.sprint.update.mockResolvedValue({ ...baseSprint, name: 'Sprint One Renamed' })
    const { PATCH } = await import('../src/app/api/sprints/[sprintId]/route')
    const req = makeRequest('http://localhost/api/sprints/sprint-1', 'PATCH', {
      name: 'Sprint One Renamed',
    })
    const res = await PATCH(req, { params: { sprintId: 'sprint-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sprint.name).toBe('Sprint One Renamed')
  })
})

// ─── DELETE /api/sprints/[sprintId] ───────────────────────────────────────────
describe('DELETE /api/sprints/[sprintId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  it('deletes sprint and unlinks cards', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(baseSprint)
    mockPrisma.card.updateMany.mockResolvedValue({ count: 3 })
    mockPrisma.sprint.delete.mockResolvedValue({})
    const { DELETE } = await import('../src/app/api/sprints/[sprintId]/route')
    const req = makeRequest('http://localhost/api/sprints/sprint-1', 'DELETE')
    const res = await DELETE(req, { params: { sprintId: 'sprint-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(mockPrisma.card.updateMany).toHaveBeenCalledWith({
      where: { sprintId: 'sprint-1' },
      data: { sprintId: null },
    })
  })

  it('returns 404 when sprint not found', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(null)
    const { DELETE } = await import('../src/app/api/sprints/[sprintId]/route')
    const req = makeRequest('http://localhost/api/sprints/nonexistent', 'DELETE')
    const res = await DELETE(req, { params: { sprintId: 'nonexistent' } })
    expect(res.status).toBe(404)
  })
})
