/**
 * Tests for webhook API routes
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
  webhook: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
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

// ─── GET /api/webhooks ────────────────────────────────────────────────────────
describe('GET /api/webhooks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when not authenticated', async () => {
    const { getIronSession } = await import('iron-session')
    vi.mocked(getIronSession).mockResolvedValueOnce({ userId: '', orgId: '', save: vi.fn() } as never)
    const { GET } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns list of webhooks without secret field', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([
      {
        id: 'webhook-1',
        orgId: 'org-1',
        url: 'https://example.com/hook',
        events: '["card.created","card.updated"]',
        secret: 'mysupersecret',
        active: true,
        createdAt: new Date(),
      },
    ])
    const { GET } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].secret).toBeUndefined()
    expect(body[0].events).toEqual(['card.created', 'card.updated'])
  })

  it('returns empty array when no webhooks', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([])
    const { GET } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('handles malformed events JSON gracefully', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([
      {
        id: 'webhook-2',
        orgId: 'org-1',
        url: 'https://example.com/hook2',
        events: 'INVALID_JSON',
        secret: 'secret',
        active: true,
        createdAt: new Date(),
      },
    ])
    const { GET } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0].events).toEqual([])
  })
})

// ─── POST /api/webhooks ───────────────────────────────────────────────────────
describe('POST /api/webhooks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 422 for missing url', async () => {
    const { POST } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'POST', {
      events: ['card.created'],
      secret: 'mysecret',
    })
    const res = await POST(req)
    expect(res.status).toBe(422)
  })

  it('returns 422 for invalid url', async () => {
    const { POST } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'POST', {
      url: 'not-a-url',
      events: ['card.created'],
      secret: 'mysecret',
    })
    const res = await POST(req)
    expect(res.status).toBe(422)
  })

  it('returns 422 for empty events array', async () => {
    const { POST } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'POST', {
      url: 'https://example.com/hook',
      events: [],
      secret: 'mysecret',
    })
    const res = await POST(req)
    expect(res.status).toBe(422)
  })

  it('returns 422 for invalid event type', async () => {
    const { POST } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'POST', {
      url: 'https://example.com/hook',
      events: ['invalid.event'],
      secret: 'mysecret',
    })
    const res = await POST(req)
    expect(res.status).toBe(422)
  })

  it('creates webhook and returns 201', async () => {
    mockPrisma.webhook.create.mockResolvedValue({
      id: 'webhook-new',
      orgId: 'org-1',
      url: 'https://example.com/hook',
      events: '["card.created"]',
      secret: 'mysecret',
      active: true,
      createdAt: new Date(),
    })
    const { POST } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'POST', {
      url: 'https://example.com/hook',
      events: ['card.created'],
      secret: 'mysecret',
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe('webhook-new')
    expect(body.events).toEqual(['card.created'])
  })

  it('returns 400 for invalid JSON body', async () => {
    const { POST } = await import('../src/app/api/webhooks/route')
    const req = new NextRequest('http://localhost/api/webhooks', {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('accepts all valid event types', async () => {
    mockPrisma.webhook.create.mockResolvedValue({
      id: 'webhook-all',
      orgId: 'org-1',
      url: 'https://example.com/hook',
      events: '["card.created","card.updated","card.moved","sprint.started","sprint.completed"]',
      secret: 'sec',
      active: true,
      createdAt: new Date(),
    })
    const { POST } = await import('../src/app/api/webhooks/route')
    const req = makeRequest('http://localhost/api/webhooks', 'POST', {
      url: 'https://example.com/hook',
      events: ['card.created', 'card.updated', 'card.moved', 'sprint.started', 'sprint.completed'],
      secret: 'sec',
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
  })
})

// ─── DELETE /api/webhooks/[webhookId] ─────────────────────────────────────────
describe('DELETE /api/webhooks/[webhookId]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when webhook not found', async () => {
    mockPrisma.webhook.findUnique.mockResolvedValue(null)
    const { DELETE } = await import('../src/app/api/webhooks/[webhookId]/route')
    const req = makeRequest('http://localhost/api/webhooks/nonexistent', 'DELETE')
    const res = await DELETE(req, { params: { webhookId: 'nonexistent' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 when webhook belongs to different org', async () => {
    mockPrisma.webhook.findUnique.mockResolvedValue({ id: 'webhook-1', orgId: 'other-org' })
    const { DELETE } = await import('../src/app/api/webhooks/[webhookId]/route')
    const req = makeRequest('http://localhost/api/webhooks/webhook-1', 'DELETE')
    const res = await DELETE(req, { params: { webhookId: 'webhook-1' } })
    expect(res.status).toBe(404)
  })

  it('deletes webhook and returns 204', async () => {
    mockPrisma.webhook.findUnique.mockResolvedValue({ id: 'webhook-1', orgId: 'org-1' })
    mockPrisma.webhook.delete.mockResolvedValue({})
    const { DELETE } = await import('../src/app/api/webhooks/[webhookId]/route')
    const req = makeRequest('http://localhost/api/webhooks/webhook-1', 'DELETE')
    const res = await DELETE(req, { params: { webhookId: 'webhook-1' } })
    expect(res.status).toBe(204)
    expect(mockPrisma.webhook.delete).toHaveBeenCalledWith({ where: { id: 'webhook-1' } })
  })
})
