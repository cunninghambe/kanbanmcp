/**
 * Tests for POST/GET /api/cards/[cardId]/signoffs
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session ────────────────────────────────────────────────────────
const mockSession = {
  userId: 'user-reviewer',
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
  card: {
    findUnique: vi.fn(),
  },
  orgMember: {
    findUnique: vi.fn(),
  },
  signoff: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
  apiKey: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
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

// Card with reviewer and approver assigned
const baseCard = {
  id: 'card-1',
  board: { orgId: 'org-1' },
  reviewerId: 'user-reviewer',
  approverId: 'user-approver',
}

const cardNoRoles = {
  id: 'card-1',
  board: { orgId: 'org-1' },
  reviewerId: null,
  approverId: null,
}

const membershipRecord = { userId: 'user-reviewer', orgId: 'org-1', role: 'MEMBER' }

function setupCard(card: typeof baseCard | typeof cardNoRoles) {
  mockPrisma.card.findUnique.mockResolvedValue(card)
  mockPrisma.orgMember.findUnique.mockResolvedValue(membershipRecord)
}

// ─── POST /api/cards/[cardId]/signoffs ────────────────────────────────────────
describe('POST /api/cards/[cardId]/signoffs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-reviewer'
    mockSession.orgId = 'org-1'
    Object.assign(mockSession, { isApiKeyAuth: undefined, agentName: undefined })
  })

  it('returns 201 when assigned reviewer submits REVIEWER signoff', async () => {
    setupCard(baseCard)
    const createdSignoff = {
      id: 'signoff-1',
      cardId: 'card-1',
      userId: 'user-reviewer',
      role: 'REVIEWER',
      decision: 'APPROVED',
      comment: 'Looks good',
      createdAt: new Date(),
      user: { id: 'user-reviewer', name: 'Reviewer', email: 'reviewer@example.com' },
    }
    mockPrisma.signoff.create.mockResolvedValue(createdSignoff)

    const { POST } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'POST', {
      role: 'REVIEWER',
      decision: 'APPROVED',
      comment: 'Looks good',
    })
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.signoff.id).toBe('signoff-1')
    expect(body.signoff.role).toBe('REVIEWER')
    expect(mockPrisma.signoff.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: 'REVIEWER',
          decision: 'APPROVED',
          userId: 'user-reviewer',
        }),
      })
    )
  })

  it('returns 201 when assigned approver submits APPROVER signoff', async () => {
    mockSession.userId = 'user-approver'
    setupCard(baseCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-approver', orgId: 'org-1', role: 'MEMBER' })
    const createdSignoff = {
      id: 'signoff-2',
      cardId: 'card-1',
      userId: 'user-approver',
      role: 'APPROVER',
      decision: 'REJECTED',
      comment: null,
      createdAt: new Date(),
      user: { id: 'user-approver', name: 'Approver', email: 'approver@example.com' },
    }
    mockPrisma.signoff.create.mockResolvedValue(createdSignoff)

    const { POST } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'POST', {
      role: 'APPROVER',
      decision: 'REJECTED',
    })
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.signoff.role).toBe('APPROVER')
  })

  it('returns 403 when user is neither reviewer nor approver (AC-7)', async () => {
    mockSession.userId = 'user-other'
    setupCard(baseCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-other', orgId: 'org-1', role: 'MEMBER' })

    const { POST } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'POST', {
      role: 'REVIEWER',
      decision: 'APPROVED',
    })
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(403)
  })

  it('returns 403 when reviewer attempts APPROVER role (E6)', async () => {
    // user-reviewer is the reviewer, not the approver
    setupCard(baseCard)

    const { POST } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'POST', {
      role: 'APPROVER',
      decision: 'APPROVED',
    })
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(403)
  })

  it('returns 400 when REVIEWER role attempted on card with no reviewer assigned (E15)', async () => {
    setupCard(cardNoRoles)

    const { POST } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'POST', {
      role: 'REVIEWER',
      decision: 'APPROVED',
    })
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('No reviewer assigned')
  })

  it('returns 400 when decision is invalid (Zod)', async () => {
    setupCard(baseCard)

    const { POST } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'POST', {
      role: 'REVIEWER',
      decision: 'MAYBE',
    })
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.issues).toBeDefined()
  })

  it('returns 400 when comment exceeds 2000 chars (Zod)', async () => {
    setupCard(baseCard)

    const { POST } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'POST', {
      role: 'REVIEWER',
      decision: 'APPROVED',
      comment: 'x'.repeat(2001),
    })
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.issues).toBeDefined()
  })

  it('returns 403 when card belongs to a different org (cross-org IDOR)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({
      id: 'card-1',
      board: { orgId: 'other-org' },
      reviewerId: 'user-reviewer',
      approverId: null,
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue(membershipRecord)

    const { POST } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'POST', {
      role: 'REVIEWER',
      decision: 'APPROVED',
    })
    const res = await POST(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(403)
  })

  it('returns 403 for API-key authenticated sessions', async () => {
    // Simulate a valid API key: requireApiKey hashes the token and looks it up.
    // We return a valid key record so requireSession succeeds with userId=''.
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      orgId: 'org-1',
      agentName: 'test-agent',
      permissions: '[]',
      keyHash: 'any',
    })
    mockPrisma.card.findUnique.mockResolvedValue({
      ...baseCard,
      reviewerId: 'user-reviewer', // '' !== 'user-reviewer' → 403
    })
    // requireOrgRole for API key sessions just checks orgId matches, no DB lookup
    mockPrisma.orgMember.findUnique.mockResolvedValue(null)

    const { POST } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const reqWithBearer = new NextRequest('http://localhost/api/cards/card-1/signoffs', {
      method: 'POST',
      body: JSON.stringify({ role: 'REVIEWER', decision: 'APPROVED' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-api-key',
      },
    })
    const res = await POST(reqWithBearer, { params: { cardId: 'card-1' } })
    // userId='' cannot equal any real reviewerId → 403
    expect(res.status).toBe(403)
  })
})

// ─── GET /api/cards/[cardId]/signoffs ─────────────────────────────────────────
describe('GET /api/cards/[cardId]/signoffs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-reviewer'
    mockSession.orgId = 'org-1'
    Object.assign(mockSession, { isApiKeyAuth: undefined, agentName: undefined })
  })

  const signoffRows = [
    {
      id: 's1',
      cardId: 'card-1',
      userId: 'user-reviewer',
      role: 'REVIEWER',
      decision: 'REQUESTED_CHANGES',
      comment: 'First pass',
      createdAt: new Date('2024-01-01T10:00:00Z'),
      user: { id: 'user-reviewer', name: 'Reviewer', email: 'r@example.com' },
    },
    {
      id: 's2',
      cardId: 'card-1',
      userId: 'user-approver',
      role: 'APPROVER',
      decision: 'APPROVED',
      comment: null,
      createdAt: new Date('2024-01-02T10:00:00Z'),
      user: { id: 'user-approver', name: 'Approver', email: 'a@example.com' },
    },
    {
      id: 's3',
      cardId: 'card-1',
      userId: 'user-reviewer',
      role: 'REVIEWER',
      decision: 'APPROVED',
      comment: 'LGTM',
      createdAt: new Date('2024-01-03T10:00:00Z'),
      user: { id: 'user-reviewer', name: 'Reviewer', email: 'r@example.com' },
    },
  ]

  it('returns all signoffs in chronological order', async () => {
    setupCard(baseCard)
    mockPrisma.signoff.findMany.mockResolvedValue(signoffRows)

    const { GET } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'GET')
    const res = await GET(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.signoffs).toHaveLength(3)
    expect(body.signoffs[0].id).toBe('s1')
    expect(body.signoffs[2].id).toBe('s3')
    // latest not included without param
    expect(body.latest).toBeUndefined()
  })

  it('returns latest per role when ?latestPerRole=true', async () => {
    setupCard(baseCard)
    mockPrisma.signoff.findMany.mockResolvedValue(signoffRows)

    const { GET } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest(
      'http://localhost/api/cards/card-1/signoffs?latestPerRole=true',
      'GET'
    )
    const res = await GET(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    // latest reviewer is s3, latest approver is s2
    expect(body.latest.reviewer.id).toBe('s3')
    expect(body.latest.approver.id).toBe('s2')
    // all signoffs still present
    expect(body.signoffs).toHaveLength(3)
  })

  it('returns 403 for non-member', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(baseCard)
    mockPrisma.orgMember.findUnique.mockResolvedValue(null)

    const { GET } = await import('../src/app/api/cards/[cardId]/signoffs/route')
    const req = makeRequest('http://localhost/api/cards/card-1/signoffs', 'GET')
    const res = await GET(req, { params: { cardId: 'card-1' } })
    expect(res.status).toBe(403)
  })
})
