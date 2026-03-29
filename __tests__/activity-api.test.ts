/**
 * Tests for activity log API route and agent-activity lib
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
  agentActivity: {
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
}

vi.mock('../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' })
}

// ─── GET /api/activity ────────────────────────────────────────────────────────
describe('GET /api/activity', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when not authenticated', async () => {
    const { getIronSession } = await import('iron-session')
    vi.mocked(getIronSession).mockResolvedValueOnce({ userId: '', orgId: '', save: vi.fn() } as never)
    const { GET } = await import('../src/app/api/activity/route')
    const req = makeRequest('http://localhost/api/activity')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns paginated activity list', async () => {
    const activities = [
      {
        id: 'act-1',
        orgId: 'org-1',
        agentName: 'test-agent',
        action: 'create_card',
        resourceType: 'card',
        resourceId: 'card-1',
        metadata: '{"title":"New Card"}',
        createdAt: new Date('2024-01-15'),
      },
    ]
    mockPrisma.agentActivity.findMany.mockResolvedValue(activities)
    mockPrisma.agentActivity.count.mockResolvedValue(1)

    const { GET } = await import('../src/app/api/activity/route')
    const req = makeRequest('http://localhost/api/activity')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activities).toHaveLength(1)
    expect(body.total).toBe(1)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(20)
  })

  it('parses metadata JSON in activities', async () => {
    mockPrisma.agentActivity.findMany.mockResolvedValue([
      {
        id: 'act-2',
        orgId: 'org-1',
        agentName: 'agent',
        action: 'update',
        resourceType: 'card',
        resourceId: 'card-2',
        metadata: '{"key":"value","count":42}',
        createdAt: new Date(),
      },
    ])
    mockPrisma.agentActivity.count.mockResolvedValue(1)
    const { GET } = await import('../src/app/api/activity/route')
    const req = makeRequest('http://localhost/api/activity')
    const res = await GET(req)
    const body = await res.json()
    expect(body.activities[0].metadata).toEqual({ key: 'value', count: 42 })
  })

  it('keeps metadata as raw string when JSON is invalid', async () => {
    mockPrisma.agentActivity.findMany.mockResolvedValue([
      {
        id: 'act-3',
        orgId: 'org-1',
        agentName: 'agent',
        action: 'update',
        resourceType: 'card',
        resourceId: 'card-3',
        metadata: 'not-json',
        createdAt: new Date(),
      },
    ])
    mockPrisma.agentActivity.count.mockResolvedValue(1)
    const { GET } = await import('../src/app/api/activity/route')
    const req = makeRequest('http://localhost/api/activity')
    const res = await GET(req)
    const body = await res.json()
    expect(body.activities[0].metadata).toBe('not-json')
  })

  it('filters by agentName when provided', async () => {
    mockPrisma.agentActivity.findMany.mockResolvedValue([])
    mockPrisma.agentActivity.count.mockResolvedValue(0)
    const { GET } = await import('../src/app/api/activity/route')
    const req = makeRequest('http://localhost/api/activity?agentName=my-agent')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(mockPrisma.agentActivity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agentName: 'my-agent' }),
      })
    )
  })

  it('respects custom page and limit', async () => {
    mockPrisma.agentActivity.findMany.mockResolvedValue([])
    mockPrisma.agentActivity.count.mockResolvedValue(50)
    const { GET } = await import('../src/app/api/activity/route')
    const req = makeRequest('http://localhost/api/activity?page=3&limit=10')
    const res = await GET(req)
    const body = await res.json()
    expect(body.page).toBe(3)
    expect(body.limit).toBe(10)
    expect(mockPrisma.agentActivity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 })
    )
  })

  it('caps limit at 100', async () => {
    mockPrisma.agentActivity.findMany.mockResolvedValue([])
    mockPrisma.agentActivity.count.mockResolvedValue(0)
    const { GET } = await import('../src/app/api/activity/route')
    const req = makeRequest('http://localhost/api/activity?limit=9999')
    const res = await GET(req)
    const body = await res.json()
    expect(body.limit).toBe(100)
  })
})

// ─── lib/agent-activity: logActivity ─────────────────────────────────────────
describe('logActivity', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates an activity record with JSON-stringified metadata', async () => {
    mockPrisma.agentActivity.create.mockResolvedValue({ id: 'new-act' })
    const { logActivity } = await import('../src/lib/agent-activity')
    await logActivity('org-1', 'agent-x', 'create', 'card', 'card-42', { title: 'Hello', count: 5 })
    expect(mockPrisma.agentActivity.create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        agentName: 'agent-x',
        action: 'create',
        resourceType: 'card',
        resourceId: 'card-42',
        metadata: '{"title":"Hello","count":5}',
      },
    })
  })

  it('handles empty metadata object', async () => {
    mockPrisma.agentActivity.create.mockResolvedValue({ id: 'act-empty' })
    const { logActivity } = await import('../src/lib/agent-activity')
    await logActivity('org-1', 'agent', 'delete', 'sprint', 'sprint-1', {})
    expect(mockPrisma.agentActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ metadata: '{}' }) })
    )
  })
})
