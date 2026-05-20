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

const CLAUDEMCP_POLL_INTERVAL_MS = 2000
const CLAUDEMCP_DEFAULT_TIMEOUT_MS = 600_000 // 10 min

function buildSystemPrompt(params: AiReviewParams): string {
  return params.customInstructions
    ? `${params.rubric}\n\n${params.customInstructions}`
    : params.rubric
}

function buildUserMessage(
  content: ExtractedContent,
  filename: string
): Anthropic.Messages.MessageParam {
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

function getClaudeMCPConfig(): { url: string; project: string } | null {
  const url = process.env.CLAUDEMCP_URL?.trim()
  const project = process.env.CLAUDEMCP_PROJECT?.trim()
  if (!url || !project) return null
  return { url, project }
}

function getAnthropicAuth(): { kind: 'oauth'; token: string } | { kind: 'apikey'; key: string } | null {
  const authToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (authToken) return { kind: 'oauth', token: authToken }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (apiKey) return { kind: 'apikey', key: apiKey }
  return null
}

async function postClaudeMCP(
  url: string,
  tool: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`ClaudeMCP HTTP ${response.status}: ${body.slice(0, 300)}`)
  }
  const raw = await response.text()
  // streamable-http transport returns `event: message\ndata: {...}\n\n`
  const match = raw.match(/^data: (.+)$/m)
  if (!match) throw new Error(`ClaudeMCP malformed response: ${raw.slice(0, 200)}`)
  const outer = JSON.parse(match[1]) as {
    error?: { message?: string }
    result?: { content?: Array<{ text?: string }> }
  }
  if (outer.error) {
    throw new Error(`ClaudeMCP error: ${outer.error.message ?? JSON.stringify(outer.error)}`)
  }
  const inner = outer.result?.content?.[0]?.text
  if (typeof inner !== 'string') {
    throw new Error(`ClaudeMCP missing content[0].text: ${raw.slice(0, 200)}`)
  }
  return JSON.parse(inner) as Record<string, unknown>
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function runViaClaudeMCP(
  params: AiReviewParams,
  content: ExtractedContent,
  filename: string,
  cfg: { url: string; project: string }
): Promise<ClaudeReviewResult> {
  if (content.kind === 'image') {
    throw new Error('ClaudeMCP cannot review image artifacts (no multimodal pass-through)')
  }
  const systemPrompt = buildSystemPrompt(params)
  const userText = content.kind === 'text' ? content.text ?? '' : ''
  const fullPrompt = `${systemPrompt}\n\nReview this artifact (filename: ${filename}):\n\n${userText}`
  const timeoutMs = Number(process.env.CLAUDEMCP_TIMEOUT_MS) || CLAUDEMCP_DEFAULT_TIMEOUT_MS

  const submit = await postClaudeMCP(cfg.url, 'claude_run', {
    project: cfg.project,
    prompt: fullPrompt,
    timeoutMs,
  })
  const jobId = submit.jobId
  if (typeof jobId !== 'string' || !jobId) {
    throw new Error(`ClaudeMCP did not return jobId: ${JSON.stringify(submit).slice(0, 200)}`)
  }

  const deadline = Date.now() + timeoutMs + 30_000
  let lastState: string = String(submit.state ?? 'queued')

  while (Date.now() < deadline) {
    await sleep(CLAUDEMCP_POLL_INTERVAL_MS)
    const status = await postClaudeMCP(cfg.url, 'claude_job_status', { jobId })
    lastState = String(status.state ?? 'unknown')
    if (lastState === 'done') {
      const output = typeof status.output === 'string' ? status.output : ''
      // ClaudeMCP does not surface token counts. Report 0; callers should treat
      // these as "unknown" rather than "actually zero".
      return { output, inputTokens: 0, outputTokens: 0 }
    }
    if (lastState === 'failed' || lastState === 'interrupted' || lastState === 'cancelled') {
      const detail = String(status.errorDetail ?? status.output ?? `state=${lastState}`)
      throw new Error(`ClaudeMCP job ${jobId} ${lastState}: ${detail.slice(0, 500)}`)
    }
  }
  throw new Error(`ClaudeMCP job ${jobId} did not complete (last state=${lastState})`)
}

async function runViaAnthropic(
  params: AiReviewParams,
  content: ExtractedContent,
  filename: string,
  auth: { kind: 'oauth'; token: string } | { kind: 'apikey'; key: string }
): Promise<ClaudeReviewResult> {
  // Prefer OAuth token when both are present — authToken wins and apiKey is suppressed
  // to avoid sending both X-Api-Key and Authorization headers simultaneously.
  const client =
    auth.kind === 'oauth'
      ? new Anthropic({ apiKey: null, authToken: auth.token })
      : new Anthropic({ apiKey: auth.key })

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

export async function runClaudeReview(
  params: AiReviewParams,
  content: ExtractedContent,
  filename: string
): Promise<ClaudeReviewResult> {
  const mcp = getClaudeMCPConfig()
  const anthropic = getAnthropicAuth()

  // Image content can't traverse ClaudeMCP (no multimodal pass-through) — must use the API.
  if (content.kind === 'image') {
    if (!anthropic) {
      throw new Error(
        'Image artifact review requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (ClaudeMCP cannot pass multimodal payloads)'
      )
    }
    return runViaAnthropic(params, content, filename, anthropic)
  }

  // Text path: prefer ClaudeMCP (subscription auth, no API spend), failover to Anthropic API.
  if (mcp) {
    try {
      return await runViaClaudeMCP(params, content, filename, mcp)
    } catch (err) {
      if (!anthropic) throw err
      console.warn(
        '[ai-review] ClaudeMCP failed, falling back to Anthropic API:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  if (!anthropic) {
    throw new Error(
      'No AI backend configured (set CLAUDEMCP_URL+CLAUDEMCP_PROJECT, or ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN)'
    )
  }
  return runViaAnthropic(params, content, filename, anthropic)
}
