/**
 * Tests for agent-auth: requireApiKey
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createHash } from 'crypto'

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  apiKey: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
}

vi.mock('../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'GET',
    headers,
  })
}

describe('requireApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.apiKey.update.mockResolvedValue({})
  })

  it('throws 401 when Authorization header is missing', async () => {
    const { requireApiKey } = await import('../src/lib/agent-auth')
    const req = makeRequest({})
    await expect(requireApiKey(req)).rejects.toMatchObject({ status: 401 })
  })

  it('throws 401 when Authorization does not start with Bearer', async () => {
    const { requireApiKey } = await import('../src/lib/agent-auth')
    const req = makeRequest({ authorization: 'Basic dXNlcjpwYXNz' })
    await expect(requireApiKey(req)).rejects.toMatchObject({ status: 401 })
  })

  it('throws 401 for empty Bearer token', async () => {
    const { requireApiKey } = await import('../src/lib/agent-auth')
    const req = makeRequest({ authorization: 'Bearer ' })
    await expect(requireApiKey(req)).rejects.toMatchObject({ status: 401 })
  })

  it('throws 401 when API key not found in DB', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null)
    const { requireApiKey } = await import('../src/lib/agent-auth')
    const req = makeRequest({ authorization: 'Bearer invalidkey123' })
    await expect(requireApiKey(req)).rejects.toMatchObject({ status: 401 })
  })

  it('returns AgentContext on valid API key', async () => {
    const rawKey = 'validrawkey12345678901234567890123456789012345678901234567890'
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      orgId: 'org-1',
      agentName: 'my-agent',
      keyHash,
      permissions: '["read","write"]',
    })
    const { requireApiKey } = await import('../src/lib/agent-auth')
    const req = makeRequest({ authorization: `Bearer ${rawKey}` })
    const ctx = await requireApiKey(req)
    expect(ctx.orgId).toBe('org-1')
    expect(ctx.agentName).toBe('my-agent')
    expect(ctx.keyId).toBe('key-1')
    expect(ctx.permissions).toEqual(['read', 'write'])
  })

  it('handles malformed permissions JSON gracefully', async () => {
    const rawKey = 'anothervalidkey1234567890123456789012345678901234567890123456789'
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-2',
      orgId: 'org-1',
      agentName: 'bad-agent',
      keyHash,
      permissions: 'NOT_VALID_JSON',
    })
    const { requireApiKey } = await import('../src/lib/agent-auth')
    const req = makeRequest({ authorization: `Bearer ${rawKey}` })
    const ctx = await requireApiKey(req)
    expect(ctx.permissions).toEqual([])
  })

  it('handles permissions that parse to non-array', async () => {
    const rawKey = 'key3456789012345678901234567890123456789012345678901234567890123'
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-3',
      orgId: 'org-1',
      agentName: 'agent',
      keyHash,
      permissions: '"single-string"',
    })
    const { requireApiKey } = await import('../src/lib/agent-auth')
    const req = makeRequest({ authorization: `Bearer ${rawKey}` })
    const ctx = await requireApiKey(req)
    expect(ctx.permissions).toEqual([])
  })

  it('hashes the key correctly with SHA-256', async () => {
    const rawKey = 'testkey99887766554433221100aabbccddeeff00112233445566778899aabbcc'
    const expectedHash = createHash('sha256').update(rawKey).digest('hex')
    mockPrisma.apiKey.findUnique.mockResolvedValue(null)
    const { requireApiKey } = await import('../src/lib/agent-auth')
    const req = makeRequest({ authorization: `Bearer ${rawKey}` })
    try {
      await requireApiKey(req)
    } catch {
      // Expected to throw
    }
    expect(mockPrisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: expectedHash },
    })
  })
})
