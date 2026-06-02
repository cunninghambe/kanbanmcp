/**
 * Tests for GET/PUT /api/orgs/[orgId]/ai-settings
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session (cookie auth) ─────────────────────────────────────────
const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  orgAiSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  orgMember: { findUnique: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

// ─── Test encryption key ──────────────────────────────────────────────────────
const TEST_KEY = 'b'.repeat(64)
process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY

const ORG_ID = 'org-1'

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/orgs/${ORG_ID}/ai-settings`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function getHandlers() {
  // Dynamic import so vi.mock hoisting applies
  const mod = await import(`../../src/app/api/orgs/[orgId]/ai-settings/route`)
  return { GET: mod.GET as typeof mod.GET, PUT: mod.PUT as typeof mod.PUT }
}

const routeCtx = { params: Promise.resolve({ orgId: ORG_ID }) }

describe('GET /api/orgs/[orgId]/ai-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Authenticate by default (session user is a MEMBER)
    mockSession.userId = 'user-1'
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: ORG_ID, role: 'MEMBER' })
  })

  it('returns 401 when unauthenticated', async () => {
    // Override iron-session to return no userId
    const { getIronSession } = await import('iron-session')
    ;(getIronSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: '' })

    const { GET } = await getHandlers()
    const res = await GET(makeRequest('GET'), routeCtx)
    expect(res.status).toBe(401)
  })

  it('returns 403 when caller is NOT a member of the org (IDOR guard)', async () => {
    // Authenticated, but not a member → requireOrgRole throws 403.
    mockPrisma.orgMember.findUnique.mockResolvedValue(null)

    const { GET } = await getHandlers()
    const res = await GET(makeRequest('GET'), routeCtx)
    expect(res.status).toBe(403)
    // Must NOT have leaked the org's key status to a non-member.
    expect(mockPrisma.orgAiSettings.findUnique).not.toHaveBeenCalled()
  })

  it('allows a MEMBER to read settings (negative / false-positive boundary)', async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: ORG_ID, role: 'MEMBER' })
    mockPrisma.orgAiSettings.findUnique.mockResolvedValue({
      anthropicApiKeyEncrypted: 'enc',
      anthropicApiKeyLastFour: '9999',
    })

    const { GET } = await getHandlers()
    const res = await GET(makeRequest('GET'), routeCtx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.anthropicApiKey.configured).toBe(true)
    expect(body.anthropicApiKey.lastFour).toBe('9999')
  })

  it('returns configured: false when no settings row exists', async () => {
    mockPrisma.orgAiSettings.findUnique.mockResolvedValue(null)

    const { GET } = await getHandlers()
    const res = await GET(makeRequest('GET'), routeCtx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.anthropicApiKey.configured).toBe(false)
    expect(body.anthropicApiKey.lastFour).toBeNull()
  })

  it('returns configured: true with lastFour when key is set', async () => {
    mockPrisma.orgAiSettings.findUnique.mockResolvedValue({
      anthropicApiKeyEncrypted: 'some-encrypted-value',
      anthropicApiKeyLastFour: '1234',
    })

    const { GET } = await getHandlers()
    const res = await GET(makeRequest('GET'), routeCtx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.anthropicApiKey.configured).toBe(true)
    expect(body.anthropicApiKey.lastFour).toBe('1234')
  })
})

describe('PUT /api/orgs/[orgId]/ai-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    mockPrisma.orgAiSettings.upsert.mockResolvedValue({})
  })

  it('returns 403 when caller is a MEMBER (not ADMIN)', async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: ORG_ID, role: 'MEMBER' })

    const { PUT } = await getHandlers()
    const res = await PUT(makeRequest('PUT', { anthropicApiKey: 'sk-ant-api03-valid-key-here' }), routeCtx)
    expect(res.status).toBe(403)
  })

  it('returns 200 and stores encrypted key when admin provides valid key', async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: ORG_ID, role: 'ADMIN' })

    const { PUT } = await getHandlers()
    const res = await PUT(makeRequest('PUT', { anthropicApiKey: 'sk-ant-api03-valid-key-here' }), routeCtx)
    expect(res.status).toBe(200)

    const upsertCall = mockPrisma.orgAiSettings.upsert.mock.calls[0][0]
    // Last four of 'sk-ant-api03-valid-key-here' = 'here'
    expect(upsertCall.create.anthropicApiKeyLastFour).toBe('here')
    // Must not store plaintext
    expect(upsertCall.create.anthropicApiKeyEncrypted).not.toBe('sk-ant-api03-valid-key-here')
    // Must be encrypted (non-empty string)
    expect(typeof upsertCall.create.anthropicApiKeyEncrypted).toBe('string')
  })

  it('returns 400 when key is empty string', async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: ORG_ID, role: 'ADMIN' })

    const { PUT } = await getHandlers()
    const res = await PUT(makeRequest('PUT', { anthropicApiKey: '' }), routeCtx)
    expect(res.status).toBe(400)
  })

  it('returns 200 and clears key when null is provided', async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: ORG_ID, role: 'ADMIN' })

    const { PUT } = await getHandlers()
    const res = await PUT(makeRequest('PUT', { anthropicApiKey: null }), routeCtx)
    expect(res.status).toBe(200)

    const upsertCall = mockPrisma.orgAiSettings.upsert.mock.calls[0][0]
    expect(upsertCall.create.anthropicApiKeyEncrypted).toBeNull()
    expect(upsertCall.create.anthropicApiKeyLastFour).toBeNull()
  })

  it('returns 400 when anthropicApiKey field is missing', async () => {
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: ORG_ID, role: 'ADMIN' })

    const { PUT } = await getHandlers()
    const res = await PUT(makeRequest('PUT', { someOtherField: 'value' }), routeCtx)
    expect(res.status).toBe(400)
  })
})
