/**
 * Tests for the rate limit guarding POST /api/cards/[cardId]/reviews.
 *
 * Each AI review spends Claude tokens, so the endpoint is throttled per org
 * (key `ai-review:<orgId>`). We mock checkRateLimit to assert:
 *  - the first request proceeds (201) and the limiter is keyed by org
 *  - exceeding the cap returns 429 before enqueueing any work
 *  - PLAYWRIGHT_E2E behavior is preserved (limiter not consulted by the route;
 *    the real checkRateLimit handles e2e bypass internally — here we just
 *    confirm the route always calls through to it)
 *
 * Mirrors the mocking pattern of card-reviews.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session ──────────────────────────────────────────────────────
const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

// ─── Mock prisma ────────────────────────────────────────────────────────────
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
  orgMember: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma }))

// ─── Mock api-helpers ───────────────────────────────────────────────────────
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

// ─── Mock rate-limit ────────────────────────────────────────────────────────
const mockCheckRateLimit = vi.fn()
vi.mock('../../src/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

// ─── Mock enqueueCardDescriptionReview ──────────────────────────────────────
const mockEnqueueDescription = vi.fn()
vi.mock('../../src/lib/ai-review/queue', () => ({
  enqueueAiReview: vi.fn(),
  enqueueCardDescriptionReview: (...args: unknown[]) => mockEnqueueDescription(...args),
  flushForTests: vi.fn(),
  bootstrapWorker: vi.fn(),
}))

// ─── Mock storage (transitive dep) ──────────────────────────────────────────
vi.mock('../../src/lib/storage', () => ({
  getStorageDriver: () => ({ put: vi.fn(), getStream: vi.fn(), delete: vi.fn() }),
}))

// ─── Mock @anthropic-ai/sdk ─────────────────────────────────────────────────
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
  RateLimitError: class extends Error {
    status = 429
  },
  APIError: class extends Error {
    status: number
    constructor(s: number, m: string) {
      super(m)
      this.status = s
    }
  },
}))

// ─── Mock seed-ai-reviewer ──────────────────────────────────────────────────
vi.mock('../../prisma/seed-ai-reviewer', () => ({
  AI_REVIEWER_EMAIL: 'ai-reviewer@kanbanmcp.local',
  AI_REVIEWER_NAME: 'AI Reviewer',
  ensureAiReviewerUser: vi.fn(),
}))

// ─── Fixtures ───────────────────────────────────────────────────────────────
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
  return { id: 'card-1', board: { orgId }, description }
}

function postReq() {
  return new NextRequest('http://localhost/api/cards/card-1/reviews', { method: 'POST' })
}

describe('POST /api/cards/[cardId]/reviews rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireSession.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', isApiKeyAuth: false })
    mockRequireOrgRole.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockApiError.mockImplementation((status: number, msg: string) => {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: msg }, { status })
    })
  })

  // ─── Positive: first request proceeds and limiter is keyed by org ───────────
  it('proceeds (201) when under the limit and keys the limiter by org', async () => {
    mockCheckRateLimit.mockReturnValue(true)
    mockPrisma.card.findUnique
      .mockResolvedValueOnce(makeCardWithOrg('org-1')) // org check
      .mockResolvedValueOnce(makeCardWithOrg('org-1')) // description check
    mockEnqueueDescription.mockResolvedValue(true)
    mockPrisma.aiReview.findFirst.mockResolvedValue(makeReview())

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const res = await POST(postReq(), { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(201)
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('ai-review:org-1')
    expect(mockEnqueueDescription).toHaveBeenCalledWith('card-1')
  })

  // ─── Positive: exceeding the cap returns 429 and does no work ───────────────
  it('returns 429 when the limit is exceeded, before any enqueue or DB lookup', async () => {
    mockCheckRateLimit.mockReturnValue(false)

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const res = await POST(postReq(), { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toMatch(/too many review requests/i)
    // The rate limit fires before resolving the card or enqueueing work.
    expect(mockPrisma.card.findUnique).not.toHaveBeenCalled()
    expect(mockEnqueueDescription).not.toHaveBeenCalled()
  })

  // ─── Edge case: first request proceeds, a later one is throttled ────────────
  it('lets the first request through then throttles a subsequent request', async () => {
    // First call allowed, second call blocked — simulating the cap being hit.
    mockCheckRateLimit.mockReturnValueOnce(true).mockReturnValueOnce(false)

    mockPrisma.card.findUnique
      .mockResolvedValueOnce(makeCardWithOrg('org-1'))
      .mockResolvedValueOnce(makeCardWithOrg('org-1'))
    mockEnqueueDescription.mockResolvedValue(true)
    mockPrisma.aiReview.findFirst.mockResolvedValue(makeReview())

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')

    const first = await POST(postReq(), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(first.status).toBe(201)

    const second = await POST(postReq(), { params: Promise.resolve({ cardId: 'card-1' }) })
    expect(second.status).toBe(429)
    // Only the first request enqueued work.
    expect(mockEnqueueDescription).toHaveBeenCalledTimes(1)
  })

  // ─── Edge case: limiter applied after auth (auth failures never reach it) ───
  it('does not consult the limiter when the session is unauthorized', async () => {
    const { NextResponse } = await import('next/server')
    mockRequireSession.mockRejectedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )

    const { POST } = await import('../../src/app/api/cards/[cardId]/reviews/route')
    const res = await POST(postReq(), { params: Promise.resolve({ cardId: 'card-1' }) })

    expect(res.status).toBe(401)
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
  })
})
