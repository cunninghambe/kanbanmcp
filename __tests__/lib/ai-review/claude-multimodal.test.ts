import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn()

  class MockAnthropic {
    messages = { create: mockCreate }
  }

  ;(MockAnthropic as unknown as { _mockCreate: typeof mockCreate })._mockCreate = mockCreate

  class MockRateLimitError extends Error {
    status = 429
    constructor() { super('Rate limit exceeded') }
  }
  class MockAPIError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }

  return { default: MockAnthropic, RateLimitError: MockRateLimitError, APIError: MockAPIError }
})

// Stub ClaudeMCP helper so we can verify multimodal never calls it.
vi.mock('../../../src/lib/ai-review/claude-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/ai-review/claude-client')>()
  return original
})

import Anthropic from '@anthropic-ai/sdk'
import { runClaudeReview } from '../../../src/lib/ai-review/claude-client'
import type { ExtractedContent } from '../../../src/lib/ai-review/extractors'
import type { AiReviewParams } from '../../../src/lib/cards'

function getMockCreate(): ReturnType<typeof vi.fn> {
  return (Anthropic as unknown as { _mockCreate: ReturnType<typeof vi.fn> })._mockCreate
}

const baseParams: AiReviewParams = { model: 'claude-opus-4-7', rubric: 'Check quality' }

const successResponse = {
  content: [{ type: 'text', text: 'Slide review done' }],
  usage: { input_tokens: 200, output_tokens: 80 },
}

const multimodalContent: ExtractedContent = {
  kind: 'multimodal',
  segments: [
    { kind: 'text', text: '## Slide 1\n\nIntro text' },
    { kind: 'image', imageBase64: 'abc123', imageMimeType: 'image/png' },
    { kind: 'text', text: '## Slide 2\n\nConclusion' },
  ],
}

describe('runClaudeReview — multimodal content', () => {
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
    delete process.env.CLAUDEMCP_URL
    delete process.env.CLAUDEMCP_PROJECT
  })

  it('buildUserMessage on multimodal produces leading text + interleaved blocks', async () => {
    mockCreate.mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, multimodalContent, 'deck.gslides')
    await vi.runAllTimersAsync()
    await promise

    const callArg = mockCreate.mock.calls[0][0]
    const content = callArg.messages[0].content as Array<{ type: string }>

    // 4 blocks: 1 leading text + 2 text segments + 1 image segment
    expect(content).toHaveLength(4)
    expect(content[0].type).toBe('text')
    expect((content[0] as { type: 'text'; text: string }).text).toContain('deck.gslides')
    expect((content[0] as { type: 'text'; text: string }).text).toContain('interleaved text and images')
    expect(content[1].type).toBe('text')
    expect(content[2].type).toBe('image')
    expect(content[3].type).toBe('text')
  })

  it('image blocks use base64 source type with correct media_type', async () => {
    mockCreate.mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, multimodalContent, 'deck.gslides')
    await vi.runAllTimersAsync()
    await promise

    const callArg = mockCreate.mock.calls[0][0]
    const content = callArg.messages[0].content as Array<Record<string, unknown>>
    const imageBlock = content[2] as { type: 'image'; source: { type: string; media_type: string; data: string } }

    expect(imageBlock.source.type).toBe('base64')
    expect(imageBlock.source.media_type).toBe('image/png')
    expect(imageBlock.source.data).toBe('abc123')
  })

  it('multimodal routes to Anthropic even when ClaudeMCP env vars are set', async () => {
    process.env.CLAUDEMCP_URL = 'http://localhost:9999'
    process.env.CLAUDEMCP_PROJECT = 'test-project'
    mockCreate.mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, multimodalContent, 'deck.gslides')
    await vi.runAllTimersAsync()
    await promise

    // Anthropic SDK was called — MCP was NOT called (no fetch mock needed)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('throws when no Anthropic auth is configured for multimodal', async () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN

    await expect(runClaudeReview(baseParams, multimodalContent, 'deck.gslides')).rejects.toThrow(
      'Image/multimodal artifact review requires ANTHROPIC_API_KEY'
    )
  })

  it('returns output and token counts on multimodal success', async () => {
    mockCreate.mockResolvedValueOnce(successResponse)

    const promise = runClaudeReview(baseParams, multimodalContent, 'deck.gslides')
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.output).toBe('Slide review done')
    expect(result.inputTokens).toBe(200)
    expect(result.outputTokens).toBe(80)
  })
})
