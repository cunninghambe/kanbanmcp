/**
 * Tests for:
 * - GET /api/artifacts/[artifactId]/reviews
 * - POST /api/artifacts/[artifactId]/reviews
 * - GET /api/reviews/[reviewId]
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session ────────────────────────────────────────────────────────
const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  artifact: { findUnique: vi.fn() },
  aiReview: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  card: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  comment: { create: vi.fn() },
  orgMember: { findUnique: vi.fn() },
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

// ─── Mock enqueueAiReview ─────────────────────────────────────────────────────
const mockEnqueue = vi.fn()
vi.mock('../../src/lib/ai-review/queue', () => ({
  enqueueAiReview: (...args: unknown[]) => mockEnqueue(...args),
  flushForTests: vi.fn(),
  bootstrapWorker: vi.fn(),
}))

// ─── Mock storage (needed by worker module transitively) ─────────────────────
vi.mock('../../src/lib/storage', () => ({ getStorageDriver: () => ({ put: vi.fn(), getStream: vi.fn(), delete: vi.fn() }) }))

// ─── Mock @anthropic-ai/sdk ───────────────────────────────────────────────────
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
  RateLimitError: class extends Error { status = 429 },
  APIError: class extends Error { status: number; constructor(s: number, m: string) { super(m); this.status = s } },
}))

// ─── Mock seed-ai-reviewer ────────────────────────────────────────────────────
vi.mock('../../prisma/seed-ai-reviewer', () => ({
  AI_REVIEWER_EMAIL: 'ai-reviewer@kanbanmcp.local',
  AI_REVIEWER_NAME: 'AI Reviewer',
  ensureAiReviewerUser: vi.fn(),
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const now = new Date('2025-01-01T00:00:00Z')

function makeArtifactWithOrg(orgId: string) {
  return {
    id: 'art-1',
    card: { board: { orgId } },
  }
}

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev-1',
    artifactId: 'art-1',
    status: 'done',
    model: 'claude-opus-4-7',
    rubricSnapshot: 'check quality',
    instructions: null,
    output: 'Looks good',
    errorMessage: null,
    inputTokens: 100,
    outputTokens: 50,
    startedAt: now,
    finishedAt: now,
    createdAt: now,
    ...overrides,
  }
}

describe('GET /api/artifacts/[artifactId]/reviews', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireSession.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', isApiKeyAuth: false })
    mockRequireOrgRole.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockApiError.mockImplementation((status: number, msg: string) => {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: msg }, { status })
    })
  })

  it('returns reviews ordered by createdAt DESC', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue(makeArtifactWithOrg('org-1'))
    const r1 = makeReview({ id: 'rev-1', createdAt: new Date('2025-01-02') })
    const r2 = makeReview({ id: 'rev-2', createdAt: new Date('2025-01-01') })
    mockPrisma.aiReview.findMany.mockResolvedValue([r1, r2])

    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/reviews/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/reviews')
    const res = await GET(req, { params: { artifactId: 'art-1' } })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reviews).toHaveLength(2)
    expect(body.reviews[0].id).toBe('rev-1')
    expect(body.reviews[1].id).toBe('rev-2')
  })

  it('returns 404 when artifact not found', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue(null)

    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/reviews/route')
    const req = new NextRequest('http://localhost/api/artifacts/nonexistent/reviews')
    const res = await GET(req, { params: { artifactId: 'nonexistent' } })

    expect(res.status).toBe(404)
  })

  it('returns 404 (not 403) for cross-org access (consistent hardening)', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue(makeArtifactWithOrg('org-other'))

    const { GET } = await import('../../src/app/api/artifacts/[artifactId]/reviews/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/reviews')
    const res = await GET(req, { params: { artifactId: 'art-1' } })

    expect(res.status).toBe(404)
  })
})

describe('POST /api/artifacts/[artifactId]/reviews', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireSession.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', isApiKeyAuth: false })
    mockRequireOrgRole.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockApiError.mockImplementation((status: number, msg: string) => {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: msg }, { status })
    })
  })

  it('triggers re-review, returns 202 with pending row', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue(makeArtifactWithOrg('org-1'))
    const pendingRow = makeReview({
      status: 'pending',
      output: null,
      startedAt: null,
      finishedAt: null,
    })
    mockEnqueue.mockResolvedValue(true)
    mockPrisma.aiReview.findFirst.mockResolvedValue(pendingRow)

    const { POST } = await import('../../src/app/api/artifacts/[artifactId]/reviews/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/reviews', { method: 'POST' })
    const res = await POST(req, { params: { artifactId: 'art-1' } })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.review.status).toBe('pending')
    expect(mockEnqueue).toHaveBeenCalledWith('art-1')
  })

  it('returns 404 for cross-org access', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue(makeArtifactWithOrg('org-other'))

    const { POST } = await import('../../src/app/api/artifacts/[artifactId]/reviews/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/reviews', { method: 'POST' })
    const res = await POST(req, { params: { artifactId: 'art-1' } })

    expect(res.status).toBe(404)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('returns 409 when a review is already pending or running (#5 cooldown)', async () => {
    mockPrisma.artifact.findUnique.mockResolvedValue(makeArtifactWithOrg('org-1'))
    // enqueueAiReview returns false when a pending/running review already exists
    mockEnqueue.mockResolvedValue(false)

    const { POST } = await import('../../src/app/api/artifacts/[artifactId]/reviews/route')
    const req = new NextRequest('http://localhost/api/artifacts/art-1/reviews', { method: 'POST' })
    const res = await POST(req, { params: { artifactId: 'art-1' } })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/already pending or running/)
  })
})

describe('GET /api/reviews/[reviewId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireSession.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', isApiKeyAuth: false })
    mockRequireOrgRole.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockApiError.mockImplementation((status: number, msg: string) => {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: msg }, { status })
    })
  })

  it('returns the review with correct shape', async () => {
    const review = {
      ...makeReview(),
      artifact: { card: { board: { orgId: 'org-1' } } },
    }
    mockPrisma.aiReview.findUnique.mockResolvedValue(review)

    const { GET } = await import('../../src/app/api/reviews/[reviewId]/route')
    const req = new NextRequest('http://localhost/api/reviews/rev-1')
    const res = await GET(req, { params: { reviewId: 'rev-1' } })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.review.id).toBe('rev-1')
    expect(body.review.status).toBe('done')
    expect(body.review.output).toBe('Looks good')
    expect(body.review.createdAt).toBe(now.toISOString())
  })

  it('returns 404 when review not found', async () => {
    mockPrisma.aiReview.findUnique.mockResolvedValue(null)

    const { GET } = await import('../../src/app/api/reviews/[reviewId]/route')
    const req = new NextRequest('http://localhost/api/reviews/nonexistent')
    const res = await GET(req, { params: { reviewId: 'nonexistent' } })

    expect(res.status).toBe(404)
  })

  it('returns 404 for cross-org access', async () => {
    const review = {
      ...makeReview(),
      artifact: { card: { board: { orgId: 'org-other' } } },
    }
    mockPrisma.aiReview.findUnique.mockResolvedValue(review)

    const { GET } = await import('../../src/app/api/reviews/[reviewId]/route')
    const req = new NextRequest('http://localhost/api/reviews/rev-1')
    const res = await GET(req, { params: { reviewId: 'rev-1' } })

    expect(res.status).toBe(404)
  })
})
