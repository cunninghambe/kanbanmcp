/**
 * Tests for the getAnthropicAuth DB-lookup path added in M4.
 * Verifies that runClaudeReview uses the org key before env vars.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock @anthropic-ai/sdk ───────────────────────────────────────────────────
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn()
  class MockAnthropic {
    messages = { create: mockCreate }
  }
  ;(MockAnthropic as unknown as { _mockCreate: typeof mockCreate })._mockCreate = mockCreate
  class MockRateLimitError extends Error { status = 429 }
  class MockAPIError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  }
  return { default: MockAnthropic, RateLimitError: MockRateLimitError, APIError: MockAPIError }
})

// ─── Mock prisma ──────────────────────────────────────────────────────────────
vi.mock('../../src/lib/db', () => {
  const findUnique = vi.fn()
  return { prisma: { orgAiSettings: { findUnique } } }
})

// ─── Mock secrets ─────────────────────────────────────────────────────────────
vi.mock('../../src/lib/secrets', () => {
  const decryptSecret = vi.fn()
  return { decryptSecret, encryptSecret: vi.fn(), maskApiKey: vi.fn() }
})

import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../../src/lib/db'
import { decryptSecret } from '../../src/lib/secrets'
import { runClaudeReview } from '../../src/lib/ai-review/claude-client'
import type { AiReviewParams } from '../../src/lib/cards'
import type { ExtractedContent } from '../../src/lib/ai-review/extractors'

function getMockCreate(): ReturnType<typeof vi.fn> {
  return (Anthropic as unknown as { _mockCreate: ReturnType<typeof vi.fn> })._mockCreate
}

const mockPrisma = prisma as unknown as {
  orgAiSettings: { findUnique: ReturnType<typeof vi.fn> }
}
const mockDecryptSecret = decryptSecret as ReturnType<typeof vi.fn>

const baseParams: AiReviewParams = { model: 'claude-opus-4-7', rubric: 'Check quality' }
const textContent: ExtractedContent = { kind: 'text', text: 'artifact content' }
const successResponse = {
  content: [{ type: 'text', text: 'Looks good' }],
  usage: { input_tokens: 10, output_tokens: 5 },
}

describe('runClaudeReview with DB org key', () => {
  let mockCreate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreate = getMockCreate()
    vi.useFakeTimers()
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses org DB key when orgId is provided and key is configured', async () => {
    mockPrisma.orgAiSettings.findUnique.mockResolvedValue({
      anthropicApiKeyEncrypted: 'encrypted-blob',
    })
    mockDecryptSecret.mockReturnValue('sk-ant-api03-org-key')
    mockCreate.mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, textContent, 'test.txt', 'org-1')
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.output).toBe('Looks good')
    expect(mockPrisma.orgAiSettings.findUnique).toHaveBeenCalledWith({ where: { orgId: 'org-1' } })
    expect(mockDecryptSecret).toHaveBeenCalledWith('encrypted-blob')
  })

  it('falls back to env var when org has no key configured', async () => {
    mockPrisma.orgAiSettings.findUnique.mockResolvedValue(null)
    process.env.ANTHROPIC_API_KEY = 'env-api-key'
    mockCreate.mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, textContent, 'test.txt', 'org-1')
    await vi.runAllTimersAsync()
    await promise

    expect(mockDecryptSecret).not.toHaveBeenCalled()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('falls back to env var when DB lookup throws', async () => {
    mockPrisma.orgAiSettings.findUnique.mockRejectedValue(new Error('DB connection failed'))
    process.env.ANTHROPIC_API_KEY = 'env-api-key'
    mockCreate.mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, textContent, 'test.txt', 'org-1')
    await vi.runAllTimersAsync()
    await promise

    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('throws when no key is available (no DB key, no env var)', async () => {
    mockPrisma.orgAiSettings.findUnique.mockResolvedValue(null)

    await expect(runClaudeReview(baseParams, textContent, 'test.txt', 'org-1')).rejects.toThrow(
      'No AI backend configured'
    )
  })

  it('still works with no orgId (env-var-only path)', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-api-key'
    mockCreate.mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, textContent, 'test.txt')
    await vi.runAllTimersAsync()
    await promise

    expect(mockPrisma.orgAiSettings.findUnique).not.toHaveBeenCalled()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})
