/**
 * Tests for API key management routes
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
  apiKey: {
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

// ─── GET /api/apikeys ─────────────────────────────────────────────────────────
describe('GET /api/apikeys', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when not authenticated', async () => {
    const { getIronSession } = await import('iron-session')
    vi.mocked(getIronSession).mockResolvedValueOnce({ userId: '', orgId: '', save: vi.fn() } as never)
    const { GET } = await import('../src/app/api/apikeys/route')
    const req = makeRequest('http://localhost/api/apikeys', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns list of API keys without keyHash', async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: 'key-1',
        orgId: 'org-1',
        name: 'test-agent',
        keyHash: 'secret-hash-should-not-appear',
        agentName: 'test-agent',
        permissions: '["read","write"]',
        createdAt: new Date('2024-01-01'),
        lastUsedAt: null,
      },
    ])
    const { GET } = await import('../src/app/api/apikeys/route')
    const req = makeRequest('http://localhost/api/apikeys', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].keyHash).toBeUndefined()
    expect(body[0].permissions).toEqual(['read', 'write'])
  })

  it('returns empty array when no keys exist', async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([])
    const { GET } = await import('../src/app/api/apikeys/route')
    const req = makeRequest('http://localhost/api/apikeys', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('handles malformed permissions JSON gracefully', async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: 'key-2',
        orgId: 'org-1',
        name: 'bad-agent',
        keyHash: 'hash',
        agentName: 'bad-agent',
        permissions: 'INVALID_JSON{',
        createdAt: new Date(),
        lastUsedAt: null,
      },
    ])
    const { GET } = await import('../src/app/api/apikeys/route')
    const req = makeRequest('http://localhost/api/apikeys', 'GET')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0].permissions).toEqual([])
  })
})

// ─── POST /api/apikeys ────────────────────────────────────────────────────────
describe('POST /api/apikeys', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 422 when agentName is missing', async () => {
    const { POST } = await import('../src/app/api/apikeys/route')
    const req = makeRequest('http://localhost/api/apikeys', 'POST', { permissions: [] })
    const res = await POST(req)
    expect(res.status).toBe(422)
  })

  it('returns 422 when agentName is empty string', async () => {
    const { POST } = await import('../src/app/api/apikeys/route')
    const req = makeRequest('http://localhost/api/apikeys', 'POST', {
      agentName: '',
      permissions: [],
    })
    const res = await POST(req)
    expect(res.status).toBe(422)
  })

  it('creates API key and returns raw key (201)', async () => {
    mockPrisma.apiKey.create.mockResolvedValue({
      id: 'new-key-1',
      agentName: 'my-agent',
      permissions: '["read"]',
      createdAt: new Date('2024-01-01'),
    })
    const { POST } = await import('../src/app/api/apikeys/route')
    const req = makeRequest('http://localhost/api/apikeys', 'POST', {
      agentName: 'my-agent',
      permissions: ['read'],
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe('new-key-1')
    expect(body.key).toBeDefined()
    expect(typeof body.key).toBe('string')
    expect(body.key.length).toBe(64) // 32 bytes as hex = 64 chars
  })

  it('returns 400 for invalid JSON body', async () => {
    const { POST } = await import('../src/app/api/apikeys/route')
    const req = new NextRequest('http://localhost/api/apikeys', {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

// ─── DELETE /api/apikeys/[keyId] ──────────────────────────────────────────────
describe('DELETE /api/apikeys/[keyId]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when key does not exist', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null)
    const { DELETE } = await import('../src/app/api/apikeys/[keyId]/route')
    const req = makeRequest('http://localhost/api/apikeys/nonexistent', 'DELETE')
    const res = await DELETE(req, { params: { keyId: 'nonexistent' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 when key belongs to different org', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      orgId: 'other-org',
    })
    const { DELETE } = await import('../src/app/api/apikeys/[keyId]/route')
    const req = makeRequest('http://localhost/api/apikeys/key-1', 'DELETE')
    const res = await DELETE(req, { params: { keyId: 'key-1' } })
    expect(res.status).toBe(404)
  })

  it('deletes key and returns 204', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ id: 'key-1', orgId: 'org-1' })
    mockPrisma.apiKey.delete.mockResolvedValue({})
    const { DELETE } = await import('../src/app/api/apikeys/[keyId]/route')
    const req = makeRequest('http://localhost/api/apikeys/key-1', 'DELETE')
    const res = await DELETE(req, { params: { keyId: 'key-1' } })
    expect(res.status).toBe(204)
    expect(mockPrisma.apiKey.delete).toHaveBeenCalledWith({ where: { id: 'key-1' } })
  })
})
