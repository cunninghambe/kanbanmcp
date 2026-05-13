/**
 * Tests for description-only AI review:
 * - enqueueCardDescriptionReview behaviour
 * - Worker processing of description reviews
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock @anthropic-ai/sdk ───────────────────────────────────────────────────
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {},
  RateLimitError: class extends Error { status = 429 },
  APIError: class extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))

// ─── Mock pdf-parse ───────────────────────────────────────────────────────────
vi.mock('pdf-parse', () => ({
  PDFParse: vi.fn(() => ({
    getText: vi.fn().mockResolvedValue({ text: '' }),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}))

// ─── Mock storage ─────────────────────────────────────────────────────────────
vi.mock('../../src/lib/storage', () => {
  const driver = { put: vi.fn(), getStream: vi.fn(), delete: vi.fn() }
  return { getStorageDriver: () => driver }
})

// ─── Mock seed-ai-reviewer ────────────────────────────────────────────────────
vi.mock('../../prisma/seed-ai-reviewer', () => ({
  AI_REVIEWER_EMAIL: 'ai-reviewer@kanbanmcp.local',
  AI_REVIEWER_NAME: 'AI Reviewer',
  ensureAiReviewerUser: vi.fn().mockResolvedValue({ id: 'reviewer-1' }),
}))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
vi.mock('../../src/lib/db', () => {
  const p = {
    artifact: { findUnique: vi.fn() },
    card: { findUnique: vi.fn() },
    aiReview: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    comment: { create: vi.fn() },
    user: { findUnique: vi.fn() },
  }
  return { prisma: p }
})

// ─── Import after mocks ───────────────────────────────────────────────────────
import { prisma } from '../../src/lib/db'
import {
  enqueueCardDescriptionReview,
  flushForTests,
  __setClaudeClientForTests,
  resetQueueForTests,
} from '../../src/lib/ai-review/worker'

const mockPrisma = prisma as unknown as {
  card: { findUnique: ReturnType<typeof vi.fn> }
  aiReview: {
    create: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  artifact: { findUnique: ReturnType<typeof vi.fn> }
  comment: { create: ReturnType<typeof vi.fn> }
  user: { findUnique: ReturnType<typeof vi.fn> }
}

// ─── Mock inheritance ─────────────────────────────────────────────────────────
vi.mock('../../src/lib/ai-review/inheritance', () => ({
  resolveEffectiveAiReviewParams: vi.fn().mockResolvedValue({
    model: 'claude-opus-4-7',
    rubric: 'check code quality',
    customInstructions: null,
  }),
}))

import { resolveEffectiveAiReviewParams } from '../../src/lib/ai-review/inheritance'
const mockResolveParams = resolveEffectiveAiReviewParams as ReturnType<typeof vi.fn>

let reviewIdCounter = 0

function makeDescriptionReviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `review-${reviewIdCounter++}`,
    artifactId: null,
    cardId: 'card-1',
    status: 'pending',
    model: 'claude-opus-4-7',
    rubricSnapshot: 'check code quality',
    instructions: null,
    output: null,
    errorMessage: null,
    inputTokens: null,
    outputTokens: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    artifact: null,
    ...overrides,
  }
}

// ─── enqueueCardDescriptionReview ─────────────────────────────────────────────
describe('enqueueCardDescriptionReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetQueueForTests()
    reviewIdCounter = 0
    mockResolveParams.mockResolvedValue({
      model: 'claude-opus-4-7',
      rubric: 'check code quality',
      customInstructions: null,
    })
  })

  it('returns true and creates a pending row when card exists and no duplicate', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ id: 'card-1' })
    mockPrisma.aiReview.findFirst.mockResolvedValue(null) // no existing
    const row = makeDescriptionReviewRow()
    mockPrisma.aiReview.create.mockResolvedValue(row)
    // runReview will update and re-fetch
    mockPrisma.aiReview.update.mockResolvedValue(row)
    mockPrisma.aiReview.findUnique.mockResolvedValue({ ...row, artifact: null })
    mockPrisma.card.findUnique.mockResolvedValue({ id: 'card-1', description: 'Some content' })

    const result = await enqueueCardDescriptionReview('card-1')

    expect(result).toBe(true)
    expect(mockPrisma.aiReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ artifactId: null, cardId: 'card-1', status: 'pending' }),
    })
  })

  it('returns false when card does not exist', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)

    const result = await enqueueCardDescriptionReview('nonexistent')

    expect(result).toBe(false)
    expect(mockPrisma.aiReview.create).not.toHaveBeenCalled()
  })

  it('returns false when a pending description review already exists', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ id: 'card-1' })
    mockPrisma.aiReview.findFirst.mockResolvedValue({ id: 'existing-review' })

    const result = await enqueueCardDescriptionReview('card-1')

    expect(result).toBe(false)
    expect(mockPrisma.aiReview.create).not.toHaveBeenCalled()
  })

  it('creates a failed row and returns true when params are not configured', async () => {
    mockPrisma.card.findUnique.mockResolvedValue({ id: 'card-1' })
    mockPrisma.aiReview.findFirst.mockResolvedValue(null)
    mockResolveParams.mockResolvedValue(null)
    mockPrisma.aiReview.create.mockResolvedValue(makeDescriptionReviewRow({ status: 'failed' }))

    const result = await enqueueCardDescriptionReview('card-1')

    expect(result).toBe(true)
    expect(mockPrisma.aiReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        artifactId: null,
        cardId: 'card-1',
        status: 'failed',
        errorMessage: 'No review params configured',
      }),
    })
  })
})

// ─── Worker processing of description reviews ─────────────────────────────────
describe('worker: description review processing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetQueueForTests()
    reviewIdCounter = 0
    mockResolveParams.mockResolvedValue({
      model: 'claude-opus-4-7',
      rubric: 'check code quality',
      customInstructions: null,
    })
  })

  it('uses card description as text content and posts comment', async () => {
    __setClaudeClientForTests(async (_params, content, _filename) => {
      expect(content.kind).toBe('text')
      if (content.kind === 'text') expect(content.text).toBe('Review this description')
      return { output: 'Looks good', inputTokens: 10, outputTokens: 5 }
    })

    const row = makeDescriptionReviewRow()
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1' }) // enqueue: card exists
      .mockResolvedValueOnce({ id: 'card-1', description: 'Review this description' }) // worker
    mockPrisma.aiReview.findFirst.mockResolvedValue(null)
    mockPrisma.aiReview.create.mockResolvedValue(row)
    mockPrisma.aiReview.update.mockResolvedValue(row)
    mockPrisma.aiReview.findUnique.mockResolvedValue({ ...row, artifact: null })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'reviewer-1' })
    mockPrisma.comment.create.mockResolvedValue({})

    await enqueueCardDescriptionReview('card-1')
    await flushForTests()

    expect(mockPrisma.comment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cardId: 'card-1',
        content: expect.stringContaining('Looks good'),
      }),
    })

    __setClaudeClientForTests(null)
  })

  it('marks review skipped when card is deleted before processing', async () => {
    __setClaudeClientForTests(async () => ({ output: 'ok', inputTokens: 1, outputTokens: 1 }))

    const row = makeDescriptionReviewRow()
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1' }) // enqueue
      .mockResolvedValueOnce(null) // worker: card gone
    mockPrisma.aiReview.findFirst.mockResolvedValue(null)
    mockPrisma.aiReview.create.mockResolvedValue(row)
    mockPrisma.aiReview.update.mockResolvedValue(row)
    mockPrisma.aiReview.findUnique.mockResolvedValue({ ...row, artifact: null })

    await enqueueCardDescriptionReview('card-1')
    await flushForTests()

    const skipCall = mockPrisma.aiReview.update.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        'data' in (c[0] as Record<string, unknown>) &&
        (c[0] as Record<string, unknown>).data !== null &&
        typeof (c[0] as Record<string, unknown>).data === 'object' &&
        ((c[0] as Record<string, unknown>).data as Record<string, unknown>).status === 'skipped',
    )
    expect(skipCall).toBeDefined()

    __setClaudeClientForTests(null)
  })

  it('marks review skipped when description is empty', async () => {
    __setClaudeClientForTests(async () => ({ output: 'ok', inputTokens: 1, outputTokens: 1 }))

    const row = makeDescriptionReviewRow()
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1' }) // enqueue
      .mockResolvedValueOnce({ id: 'card-1', description: '' }) // worker: empty
    mockPrisma.aiReview.findFirst.mockResolvedValue(null)
    mockPrisma.aiReview.create.mockResolvedValue(row)
    mockPrisma.aiReview.update.mockResolvedValue(row)
    mockPrisma.aiReview.findUnique.mockResolvedValue({ ...row, artifact: null })

    await enqueueCardDescriptionReview('card-1')
    await flushForTests()

    const skipCall = mockPrisma.aiReview.update.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        'data' in (c[0] as Record<string, unknown>) &&
        ((c[0] as Record<string, unknown>).data as Record<string, unknown>).status === 'skipped',
    )
    expect(skipCall).toBeDefined()

    __setClaudeClientForTests(null)
  })

  it('does not check artifact existence for description reviews', async () => {
    __setClaudeClientForTests(async () => ({ output: 'Good', inputTokens: 5, outputTokens: 3 }))

    const row = makeDescriptionReviewRow()
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1' }) // enqueue
      .mockResolvedValueOnce({ id: 'card-1', description: 'Real content here' }) // worker
    mockPrisma.aiReview.findFirst.mockResolvedValue(null)
    mockPrisma.aiReview.create.mockResolvedValue(row)
    mockPrisma.aiReview.update.mockResolvedValue(row)
    mockPrisma.aiReview.findUnique.mockResolvedValue({ ...row, artifact: null })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'reviewer-1' })
    mockPrisma.comment.create.mockResolvedValue({})

    await enqueueCardDescriptionReview('card-1')
    await flushForTests()

    expect(mockPrisma.artifact.findUnique).not.toHaveBeenCalled()

    __setClaudeClientForTests(null)
  })
})
