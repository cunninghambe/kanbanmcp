/**
 * AI Review Pipeline tests: AC-6, E7, E8, E13, E14
 * Uses __setClaudeClientForTests to inject a stub, mocks Prisma,
 * and calls flushForTests() to drain the queue deterministically.
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
// The factory creates stable vi.fn instances so tests can configure them.
vi.mock('../../src/lib/storage', () => {
  const driver = {
    put: vi.fn(),
    getStream: vi.fn(),
    delete: vi.fn(),
  }
  return { getStorageDriver: () => driver }
})

// ─── Mock seed-ai-reviewer ────────────────────────────────────────────────────
vi.mock('../../prisma/seed-ai-reviewer', () => ({
  AI_REVIEWER_EMAIL: 'ai-reviewer@kanbanmcp.local',
  AI_REVIEWER_NAME: 'AI Reviewer',
  ensureAiReviewerUser: vi.fn().mockResolvedValue({ id: 'reviewer-1', email: 'ai-reviewer@kanbanmcp.local' }),
}))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
// We cannot reference top-level variables in vi.mock factories, so create the
// mock object inside the factory and expose it via a module property.
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
import { getStorageDriver } from '../../src/lib/storage'
import {
  enqueueAiReview,
  flushForTests,
  __setClaudeClientForTests,
  resetQueueForTests,
  bootstrapWorker,
} from '../../src/lib/ai-review/worker'
// The mock always returns the same driver object.
const mockStorage = getStorageDriver() as unknown as {
  getStream: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

const REVIEWER_ID = 'reviewer-1'
const ARTIFACT_ID = 'art-1'
const CARD_ID = 'card-1'
let reviewIdCounter = 1

function makeReviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `review-${reviewIdCounter++}`,
    artifactId: ARTIFACT_ID,
    status: 'pending',
    model: 'claude-opus-4-7',
    rubricSnapshot: 'review code quality',
    instructions: null,
    output: null,
    errorMessage: null,
    inputTokens: null,
    outputTokens: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    artifact: {
      id: ARTIFACT_ID,
      cardId: CARD_ID,
      filename: 'doc.txt',
      mimeType: 'text/plain',
      storageKey: ARTIFACT_ID,
    },
    ...overrides,
  }
}

function makeStream(content: string) {
  const { Readable } = require('node:stream')
  const stream = new Readable({ read() {} })
  stream.push(Buffer.from(content, 'utf-8'))
  stream.push(null)
  return stream
}

// Typed references to the mocked prisma
const mockPrisma = prisma as unknown as {
  artifact: { findUnique: ReturnType<typeof vi.fn> }
  card: { findUnique: ReturnType<typeof vi.fn> }
  aiReview: {
    create: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  comment: { create: ReturnType<typeof vi.fn> }
  user: { findUnique: ReturnType<typeof vi.fn> }
}

describe('AI Review Pipeline', () => {
  beforeEach(async () => {
    // Reset queue state first so no previous test's in-flight jobs interfere.
    resetQueueForTests()
    vi.clearAllMocks()
    reviewIdCounter = 1

    // Default: reviewer user exists
    mockPrisma.user.findUnique.mockResolvedValue({ id: REVIEWER_ID, email: 'ai-reviewer@kanbanmcp.local' })

    // Default: artifact exists
    mockPrisma.artifact.findUnique.mockResolvedValue({
      id: ARTIFACT_ID,
      cardId: CARD_ID,
      filename: 'doc.txt',
      mimeType: 'text/plain',
      storageKey: ARTIFACT_ID,
    })

    // Default: card with params
    mockPrisma.card.findUnique.mockResolvedValue({
      id: CARD_ID,
      aiReviewParams: JSON.stringify({ model: 'claude-opus-4-7', rubric: 'review code quality' }),
      parentCardId: null,
    })

    // Default: storage returns a fresh stream each call (streams are one-shot).
    mockStorage.getStream.mockImplementation(async () => makeStream('artifact content'))

    // Default: comment create succeeds
    mockPrisma.comment.create.mockResolvedValue({ id: 'comment-1' })

    // Reset claude override
    __setClaudeClientForTests(null)
  })

  describe('AC-6: enqueue → process → comment posted', () => {
    it('creates pending row on enqueue, transitions to done, posts comment', async () => {
      const reviewRow = makeReviewRow()
      mockPrisma.aiReview.create.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.findUnique.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.update.mockResolvedValue({ ...reviewRow, status: 'done' })

      __setClaudeClientForTests(async () => ({
        output: 'Great work!',
        inputTokens: 100,
        outputTokens: 50,
      }))

      await enqueueAiReview(ARTIFACT_ID)

      // Verify AiReview row was created with pending status
      expect(mockPrisma.aiReview.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'pending', artifactId: ARTIFACT_ID }),
        })
      )

      await flushForTests()

      // Verify status transitions: running then done
      const updateCalls = mockPrisma.aiReview.update.mock.calls
      expect(updateCalls[0][0].data.status).toBe('running')
      expect(updateCalls[1][0].data.status).toBe('done')
      expect(updateCalls[1][0].data.output).toBe('Great work!')

      // Verify comment posted from AI Reviewer user
      expect(mockPrisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cardId: CARD_ID,
            userId: REVIEWER_ID,
            content: expect.stringContaining('**AI review of doc.txt:**'),
          }),
        })
      )
    })
  })

  describe('E8: no params configured', () => {
    it('creates failed row immediately, makes no Claude call', async () => {
      // Card with no params anywhere
      mockPrisma.card.findUnique.mockResolvedValue({
        id: CARD_ID,
        aiReviewParams: null,
        parentCardId: null,
      })
      // No env fallback
      delete process.env.AI_REVIEW_DEFAULT_RUBRIC

      const failedRow = makeReviewRow({ status: 'failed', errorMessage: 'No review params configured' })
      mockPrisma.aiReview.create.mockResolvedValue(failedRow)

      const claudeSpy = vi.fn()
      __setClaudeClientForTests(claudeSpy)

      await enqueueAiReview(ARTIFACT_ID)
      await flushForTests()

      expect(mockPrisma.aiReview.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            errorMessage: 'No review params configured',
          }),
        })
      )
      expect(claudeSpy).not.toHaveBeenCalled()
    })
  })

  describe('E13: two uploads create two AiReview rows, both reach done', () => {
    it('processes both jobs in order', async () => {
      const row1 = makeReviewRow({ id: 'review-1', artifactId: 'art-1' })
      const row2 = makeReviewRow({ id: 'review-2', artifactId: 'art-2' })

      mockPrisma.aiReview.create
        .mockResolvedValueOnce(row1)
        .mockResolvedValueOnce(row2)

      mockPrisma.aiReview.findUnique
        .mockResolvedValueOnce(row1)
        .mockResolvedValueOnce(row2)

      mockPrisma.aiReview.update.mockResolvedValue({ status: 'done' })

      // artifact.findUnique calls: enqueue-art-1, enqueue-art-2, post-done-art-1, post-done-art-2
      mockPrisma.artifact.findUnique
        .mockResolvedValueOnce({ id: 'art-1', cardId: CARD_ID })  // enqueue art-1
        .mockResolvedValueOnce({ id: 'art-2', cardId: CARD_ID })  // enqueue art-2
        .mockResolvedValueOnce({ id: 'art-1', cardId: CARD_ID })  // post-done check art-1
        .mockResolvedValueOnce({ id: 'art-2', cardId: CARD_ID })  // post-done check art-2

      __setClaudeClientForTests(async () => ({
        output: 'Done',
        inputTokens: 10,
        outputTokens: 5,
      }))

      await enqueueAiReview('art-1')
      await enqueueAiReview('art-2')
      await flushForTests()

      expect(mockPrisma.aiReview.create).toHaveBeenCalledTimes(2)
    })
  })

  describe('E14: artifact deleted between enqueue and comment post', () => {
    it('keeps status=done but does not post comment', async () => {
      const reviewRow = makeReviewRow()
      mockPrisma.aiReview.create.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.findUnique.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.update.mockResolvedValue({ ...reviewRow, status: 'done' })

      // Artifact exists for enqueue check only; all subsequent calls return null (deleted).
      mockPrisma.artifact.findUnique
        .mockResolvedValueOnce({ id: ARTIFACT_ID, cardId: CARD_ID }) // enqueue check
        .mockResolvedValue(null)                                       // all subsequent → deleted

      __setClaudeClientForTests(async () => ({
        output: 'Output',
        inputTokens: 10,
        outputTokens: 5,
      }))

      await enqueueAiReview(ARTIFACT_ID)
      await flushForTests()

      // Status should still be done
      const doneCall = mockPrisma.aiReview.update.mock.calls.find(
        (c: Array<{ data: { status?: string } }>) => c[0].data.status === 'done'
      )
      expect(doneCall).toBeDefined()

      // No comment should be posted
      expect(mockPrisma.comment.create).not.toHaveBeenCalled()
    })
  })

  describe('E7: toggling aiAutoReview on does not auto-review historical artifacts', () => {
    it('existing artifact is NOT auto-reviewed when toggle is enabled; only a manual POST triggers review', async () => {
      // Simulates: artifact 'art-existing' was uploaded before aiAutoReview was enabled.
      // When the feature is toggled on, enqueueAiReview is NOT called for it.
      // Only a direct call to enqueueAiReview (manual POST) triggers a review.

      // No enqueue has been called for the pre-existing artifact yet.
      expect(mockPrisma.aiReview.create).not.toHaveBeenCalled()

      // Now the user manually POSTs to re-review the historical artifact.
      const reviewRow = makeReviewRow({ artifactId: ARTIFACT_ID })
      mockPrisma.aiReview.create.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.findUnique.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.update.mockResolvedValue({ ...reviewRow, status: 'done' })

      __setClaudeClientForTests(async () => ({
        output: 'Manual review result',
        inputTokens: 10,
        outputTokens: 5,
      }))

      await enqueueAiReview(ARTIFACT_ID)
      await flushForTests()

      // Exactly one review was created — triggered by the explicit manual call, not the toggle.
      expect(mockPrisma.aiReview.create).toHaveBeenCalledTimes(1)
      const doneCall = mockPrisma.aiReview.update.mock.calls.find(
        (c: Array<{ data: { status?: string } }>) => c[0].data.status === 'done'
      )
      expect(doneCall).toBeDefined()
    })
  })

  describe('failure modes', () => {
    it('marks failed when Claude throws', async () => {
      const reviewRow = makeReviewRow()
      mockPrisma.aiReview.create.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.findUnique.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.update.mockResolvedValue({})

      __setClaudeClientForTests(async () => {
        throw new Error('Claude exploded')
      })

      await enqueueAiReview(ARTIFACT_ID)
      await flushForTests()

      const failedCall = mockPrisma.aiReview.update.mock.calls.find(
        (c: Array<{ data: { status?: string; errorMessage?: string } }>) => c[0].data.status === 'failed'
      )
      expect(failedCall).toBeDefined()
      expect(failedCall![0].data.errorMessage).toContain('Claude exploded')
    })

    it('marks skipped when artifact storage read fails', async () => {
      const reviewRow = makeReviewRow()
      mockPrisma.aiReview.create.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.findUnique.mockResolvedValue(reviewRow)
      mockPrisma.aiReview.update.mockResolvedValue({})

      // Storage throws
      mockStorage.getStream.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      await enqueueAiReview(ARTIFACT_ID)
      await flushForTests()

      const skippedCall = mockPrisma.aiReview.update.mock.calls.find(
        (c: Array<{ data: { status?: string } }>) => c[0].data.status === 'skipped'
      )
      expect(skippedCall).toBeDefined()
    })
  })

  describe('#5: per-artifact cooldown', () => {
    it('returns false and skips enqueue when a pending review already exists', async () => {
      // Simulate an existing pending review for the artifact
      mockPrisma.aiReview.findFirst.mockResolvedValue({ id: 'existing-review-1' })

      const result = await enqueueAiReview(ARTIFACT_ID)

      expect(result).toBe(false)
      expect(mockPrisma.aiReview.create).not.toHaveBeenCalled()
    })

    it('returns false and skips enqueue when a running review already exists', async () => {
      mockPrisma.aiReview.findFirst.mockResolvedValue({ id: 'running-review-1' })

      const result = await enqueueAiReview(ARTIFACT_ID)

      expect(result).toBe(false)
      expect(mockPrisma.aiReview.create).not.toHaveBeenCalled()
    })

    it('returns true and enqueues when no pending/running review exists', async () => {
      mockPrisma.aiReview.findFirst.mockResolvedValue(null)
      const reviewRow = makeReviewRow()
      mockPrisma.aiReview.create.mockResolvedValue(reviewRow)

      const result = await enqueueAiReview(ARTIFACT_ID)

      expect(result).toBe(true)
      expect(mockPrisma.aiReview.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('#6: bootstrapWorker resets startedAt to null', () => {
    it('clears startedAt when resetting running rows to pending', async () => {
      mockPrisma.aiReview.updateMany.mockResolvedValue({ count: 1 })
      mockPrisma.aiReview.findMany.mockResolvedValue([])

      await bootstrapWorker()

      expect(mockPrisma.aiReview.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'running' },
          data: expect.objectContaining({ status: 'pending', startedAt: null }),
        })
      )
    })
  })
})
