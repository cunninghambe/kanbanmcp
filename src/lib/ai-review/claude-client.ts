import Anthropic, { APIError, RateLimitError } from '@anthropic-ai/sdk'
import type { ExtractedContent } from './extractors'
import type { AiReviewParams } from '@/lib/cards'

export interface ClaudeReviewResult {
  output: string
  inputTokens: number
  outputTokens: number
}

// Retry delays in ms: attempt 0→1 waits 1s, 1→2 waits 4s, 2→3 waits 16s.
const RETRY_DELAYS = [1000, 4000, 16000]
const MAX_ATTEMPTS = 3

function buildSystemPrompt(params: AiReviewParams): string {
  return params.customInstructions
    ? `${params.rubric}\n\n${params.customInstructions}`
    : params.rubric
}

function buildUserMessage(content: ExtractedContent, filename: string): Anthropic.Messages.MessageParam {
  if (content.kind === 'image') {
    return {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: content.imageMimeType as 'image/png' | 'image/jpeg' | 'image/webp',
            data: content.imageBase64,
          },
        },
        { type: 'text', text: `Review this artifact (filename: ${filename}).` },
      ],
    }
  }

  return {
    role: 'user',
    content: `Review this artifact (filename: ${filename}):\n\n${content.text ?? ''}`,
  }
}

function shouldRetry(err: unknown): boolean {
  if (err instanceof RateLimitError) return true
  if (err instanceof APIError) return err.status >= 500
  // Network errors (not APIError instances)
  return !(err instanceof APIError)
}

export async function runClaudeReview(
  params: AiReviewParams,
  content: ExtractedContent,
  filename: string
): Promise<ClaudeReviewResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const client = new Anthropic({ apiKey })
  const systemPrompt = buildSystemPrompt(params)
  const userMessage = buildUserMessage(content, filename)

  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.messages.create({
        model: params.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [userMessage],
      })

      const output = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')

      return {
        output,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    } catch (err) {
      lastErr = err
      if (!shouldRetry(err) || attempt === MAX_ATTEMPTS - 1) break
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]))
    }
  }

  throw lastErr
}
