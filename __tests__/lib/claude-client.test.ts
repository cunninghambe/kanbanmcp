import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// vi.mock is hoisted; factory must not reference external variables.
// We use a module-level approach: the mock create fn is attached as a property
// on the mock class constructor itself so tests can reach it.
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn()

  class MockAnthropic {
    messages = { create: mockCreate }
  }

  // Expose the create fn on the constructor for test access.
  ;(MockAnthropic as unknown as { _mockCreate: typeof mockCreate })._mockCreate = mockCreate

  class MockRateLimitError extends Error {
    status = 429
    constructor() { super('Rate limit exceeded') }
  }
  class MockAPIError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  }

  return {
    default: MockAnthropic,
    RateLimitError: MockRateLimitError,
    APIError: MockAPIError,
  }
})

import Anthropic, { RateLimitError, APIError } from '@anthropic-ai/sdk'
import { runClaudeReview } from '../../src/lib/ai-review/claude-client'
import type { AiReviewParams } from '../../src/lib/cards'
import type { ExtractedContent } from '../../src/lib/ai-review/extractors'

function getMockCreate(): ReturnType<typeof vi.fn> {
  return (Anthropic as unknown as { _mockCreate: ReturnType<typeof vi.fn> })._mockCreate
}

const baseParams: AiReviewParams = {
  model: 'claude-opus-4-7',
  rubric: 'Check for quality issues',
}

const textContent: ExtractedContent = {
  kind: 'text',
  text: 'This is the artifact content',
}

const successResponse = {
  content: [{ type: 'text', text: 'Looks great!' }],
  usage: { input_tokens: 100, output_tokens: 50 },
}

describe('runClaudeReview', () => {
  let mockCreate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreate = getMockCreate()
    process.env.ANTHROPIC_API_KEY = 'test-key'
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ANTHROPIC_API_KEY
  })

  it('returns output and token counts on success', async () => {
    mockCreate.mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, textContent, 'test.txt')
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.output).toBe('Looks great!')
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(50)
  })

  it('sends image message for image content', async () => {
    mockCreate.mockResolvedValueOnce(successResponse)
    const imageContent: ExtractedContent = {
      kind: 'image',
      imageBase64: 'abc123',
      imageMimeType: 'image/png',
    }

    const promise = runClaudeReview(baseParams, imageContent, 'img.png')
    await vi.runAllTimersAsync()
    await promise

    const callArg = mockCreate.mock.calls[0][0]
    expect(callArg.messages[0].content).toBeInstanceOf(Array)
    expect(callArg.messages[0].content[0].type).toBe('image')
  })

  it('throws immediately when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await expect(runClaudeReview(baseParams, textContent, 'test.txt')).rejects.toThrow(
      'ANTHROPIC_API_KEY not configured'
    )
  })

  it('retries on 429 and succeeds on second attempt (E9)', async () => {
    mockCreate
      // @ts-expect-error mock has simplified constructor
      .mockRejectedValueOnce(new RateLimitError())
      .mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, textContent, 'test.txt')
    await vi.advanceTimersByTimeAsync(1500)
    const result = await promise

    expect(result.output).toBe('Looks great!')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('retries on 5xx and succeeds on third attempt (E9)', async () => {
    mockCreate
      // @ts-expect-error mock has simplified constructor
      .mockRejectedValueOnce(new APIError(500, '5xx error'))
      // @ts-expect-error mock has simplified constructor
      .mockRejectedValueOnce(new APIError(503, '503 error'))
      .mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, textContent, 'test.txt')
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result.output).toBe('Looks great!')
    expect(mockCreate).toHaveBeenCalledTimes(3)
  })

  it('throws after 3 attempts when rate-limited each time (E9 exhausted)', async () => {
    // @ts-expect-error mock has simplified constructor
    const err = new RateLimitError()
    mockCreate
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)

    const promise = runClaudeReview(baseParams, textContent, 'test.txt')
    const assertion = expect(promise).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(mockCreate).toHaveBeenCalledTimes(3)
  })

  it('does not retry on 401 (no retry on 4xx other than 429)', async () => {
    // @ts-expect-error mock has simplified constructor
    mockCreate.mockRejectedValueOnce(new APIError(401, 'Unauthorized'))

    const promise = runClaudeReview(baseParams, textContent, 'test.txt')
    const assertion = expect(promise).rejects.toThrow()
    await vi.runAllTimersAsync()
    await assertion

    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 400', async () => {
    // @ts-expect-error mock has simplified constructor
    mockCreate.mockRejectedValueOnce(new APIError(400, 'Bad request'))

    const promise = runClaudeReview(baseParams, textContent, 'test.txt')
    const assertion = expect(promise).rejects.toThrow()
    await vi.runAllTimersAsync()
    await assertion

    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('includes customInstructions in system prompt when set', async () => {
    mockCreate.mockResolvedValueOnce(successResponse)
    const paramsWithInstructions: AiReviewParams = {
      ...baseParams,
      customInstructions: 'Be strict about security',
    }

    const promise = runClaudeReview(paramsWithInstructions, textContent, 'test.txt')
    await vi.runAllTimersAsync()
    await promise

    const callArg = mockCreate.mock.calls[0][0]
    expect(callArg.system).toContain('Check for quality issues')
    expect(callArg.system).toContain('Be strict about security')
  })
})
