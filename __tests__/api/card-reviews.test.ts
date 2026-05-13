/**
 * Tests for:
 * - POST /api/cards/[cardId]/reviews  (trigger description-only AI review)
 * - GET  /api/cards/[cardId]/reviews  (list all reviews for a card)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session ────────────────────────────────────────────────────────
const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  card: { findUnique: vi.fn() },
  aiReview: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  artifact: { findUnique: vi.fn() },
  comment: { create: vi.fn() },
  orgMember: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

// ─── Mock api-helpers ─────────────────────────────────────────────────────────
const mockRequireSession = vi.fn()
const mockRequireOrgRole = vi.fn()
const mockApiError = vi.fn((status: number, msg: string) => {
  const { NextResponse } = require('next/server')
  return NextResponse.json({ error: msg }, { status })
})
vi.mock('../../src/lib/api-helpers', () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
  requireOrgRole: (...args: unknown[]) => mockRequireOrgRole(...args),
  apiError: (status: number, msg: string) => mockApiError(status, msg),
}))

// ─── Mock enqueueCardDescriptionReview ────────────────────────────────────────
const mockEnqueueDescription = vi.fn()
vi.mock('../../src/lib/ai-review/queue', () => ({
  enqueueAiReview: vi.fn(),
  enqueueCardDescriptionReview: (...args: unknown[]) => mockEnqueueDescription(...args),
  flushForTests: vi.fn(),
  bootstrapWorker: vi.fn(),
}))

// ─── Mock storage (transitive dep) ────────────────────────────────────────────
vi.mock('../../src/lib/storage', () => ({
  getStorageDriver: () => ({ put: vi.fn(), getStream: vi.fn(), delete: vi.fn() }),
}))

// ─── Mock @anthropic-ai/sdk ───────────────────────────────────────────────────
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
  RateLimitError: class extends Error { status = 429 },
  APIError: class extends Error {
    status: number
    constructor(s: number, m: string) { super(m); this.status = s }
  },
}))

// ─── Mock seed-ai-reviewer ────────────────────────────────────────────────────
vi.mock('../../prisma/seed-ai-reviewer', () => ({
  AI_REVIEWER_EMAIL: 'ai-reviewer@kanbanmcp.local',
  AI_REVIEWER_NAME: 'AI Reviewer',
  ensureAiReviewerUser: vi.fn(),
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const now = new Date('2025-01-01T00:00:00Z')

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev-1',
    artifactId: null,
    cardId: 'card-1',
    status: 'pending',
    model: 'claude-opus-4-7',
    rubricSnapshot: 'check quality',
    instructions: null,
    output: null,
    errorMessage: null,
    inputTokens: null,
    outputTokens: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    ...overrides,
  }
}

function makeCardWithOrg(orgId: string, description: string | null = 'A thorough description') {
  return {
    id: 'card-1',
    board: { orgId },
    description,
  }
}

// ─── POST /api/cards/[cardId]/reviews ─────────────────────────────────────────
describe('POST /api/cards/[cardId]/reviews', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireSession.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', isApiKeyAuth: false })
    mockRequireOrgRole.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockApiError.mockImplementation((status: number, msg: string) => {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: msg }, { status })
    })
  })

  it('returns 201 with pending review row on success', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce(makeCardWithOrg('org-1')) // org check
      .mockResolvedValueOnce(makeCardWithOrg('org-1')) // description check
    mockEnqueueDescription.mockResolvedValue(true)
    const pendingRow = makeReview()
    mockPrisma.aiReview.findFirst.mockResolvedValue(pendingRow)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/reviews', { method: 'POST' })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.review.cardId).toBe('card-1')
    expect(body.review.artifactId).toBeNull()
    expect(body.review.status).toBe('pending')
    expect(mockEnqueueDescription).toHaveBeenCalledWith('card-1')
  })

  it('returns 400 when description is null', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce(makeCardWithOrg('org-1', null)) // org check
      .mockResolvedValueOnce(makeCardWithOrg('org-1', null)) // description check

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/reviews', { method: 'POST' })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/no description/i)
  })

  it('returns 400 when description is whitespace only', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce(makeCardWithOrg('org-1', '   '))
      .mockResolvedValueOnce(makeCardWithOrg('org-1', '   '))

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/reviews', { method: 'POST' })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(400)
  })

  it('returns 409 when a review is already pending or running', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce(makeCardWithOrg('org-1'))
      .mockResolvedValueOnce(makeCardWithOrg('org-1'))
    mockEnqueueDescription.mockResolvedValue(false)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/reviews', { method: 'POST' })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/already pending or running/)
  })

  it('returns 404 when card not found', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const req = new NextRequest('http://localhost/api/cards/nonexistent/reviews', { method: 'POST' })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'nonexistent' }) })

    expect(res.status).toBe(404)
    expect(mockEnqueueDescription).not.toHaveBeenCalled()
  })

  it('returns 404 for cross-org access', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(makeCardWithOrg('org-other'))

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/reviews', { method: 'POST' })
    const res = await POST(req, { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(404)
    expect(mockEnqueueDescription).not.toHaveBeenCalled()
  })
})

// ─── GET /api/cards/[cardId]/reviews ──────────────────────────────────────────
describe('GET /api/cards/[cardId]/reviews', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireSession.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', isApiKeyAuth: false })
    mockRequireOrgRole.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockApiError.mockImplementation((status: number, msg: string) => {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: msg }, { status })
    })
  })

  it('returns 200 with reviews in DESC order (mixed artifact + description)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(makeCardWithOrg('org-1'))
    const r1 = makeReview({ id: 'rev-1', artifactId: 'art-1', createdAt: new Date('2025-01-03') })
    const r2 = makeReview({ id: 'rev-2', artifactId: null, createdAt: new Date('2025-01-02') })
    const r3 = makeReview({ id: 'rev-3', artifactId: 'art-2', createdAt: new Date('2025-01-01') })
    mockPrisma.aiReview.findMany.mockResolvedValue([r1, r2, r3])

    const { GET } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/reviews')
    const res = await GET(req, { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reviews).toHaveLength(3)
    expect(body.reviews[0].id).toBe('rev-1')
    expect(body.reviews[1].id).toBe('rev-2')
    expect(body.reviews[1].artifactId).toBeNull()
    expect(body.reviews[2].id).toBe('rev-3')
  })

  it('returns 404 when card not found', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)

    const { GET } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const req = new NextRequest('http://localhost/api/cards/nonexistent/reviews')
    const res = await GET(req, { params: Promise.resolve({ cardId: 'nonexistent' }) })

    expect(res.status).toBe(404)
  })

  it('returns 404 for cross-org access', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(makeCardWithOrg('org-other'))

    const { GET } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const req = new NextRequest('http://localhost/api/cards/card-1/reviews')
    const res = await GET(req, { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(404)
  })
})
