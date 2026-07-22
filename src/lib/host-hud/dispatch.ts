// Pure helpers for mhud (the meeting HUD) dispatch: build the target-aware prompt
// and parse the agent's structured answer. No I/O here so it is trivially testable.

export const DISPATCH_TARGETS = ['board', 'drive', 'email', 'slack'] as const
export type DispatchTarget = (typeof DISPATCH_TARGETS)[number]

export function isDispatchTarget(value: unknown): value is DispatchTarget {
  return typeof value === 'string' && (DISPATCH_TARGETS as readonly string[]).includes(value)
}

export interface DispatchCitation {
  kind: string
  id?: string
  title?: string
  url?: string
  quote?: string
}

export interface DispatchAnswer {
  answer: string
  citations: DispatchCitation[]
  confidence: number | null
  /** A suggested board change, if the agent proposed one. Routed to ChangeSet. */
  suggestion: {
    summary?: string
    boardId?: string
    items: Array<{
      op: string
      payload: Record<string, unknown>
      targetCardId?: string
      evidence?: { quote: string }
      confidence?: number
    }>
  } | null
}

const TARGET_GUIDANCE: Record<DispatchTarget, string> = {
  board: 'Answer from the mhud boards/cards. Use only the board context provided and your read-only board tools.',
  drive: 'Answer from Google Drive (documents, sheets, slides) the chair has access to. Read-only.',
  email: 'Answer from the chair\'s email. Read-only — never send anything.',
  slack: 'Answer from Slack channels/DMs the chair has access to. Read-only — never post anything.',
}

export interface BuildPromptArgs {
  target: DispatchTarget
  question: string
  /** Optional pre-fetched, read-only context (e.g. a board snapshot). */
  context?: string
}

/**
 * Builds the dispatch prompt. The agent is instructed to be READ-ONLY and to
 * return a single fenced JSON object. Any board change must be expressed as a
 * `suggestion` (which becomes a pending ChangeSet) — it must NEVER act directly.
 */
export function buildDispatchPrompt(args: BuildPromptArgs): string {
  const guidance = TARGET_GUIDANCE[args.target]
  return [
    'You are a read-only meeting copilot answering a question for the meeting chair during a live meeting.',
    'STRICT RULES:',
    '1. You are READ-ONLY. Do not create, move, update, delete, send, or post anything anywhere.',
    '2. If you believe a board change is warranted, DO NOT make it. Express it under "suggestion" so a human can approve it later.',
    '3. Ground every claim in evidence and list it under "citations".',
    '',
    `TARGET: ${args.target} — ${guidance}`,
    '',
    `QUESTION: ${args.question}`,
    args.context ? `\nCONTEXT (read-only):\n${args.context}` : '',
    '',
    'Respond with ONE fenced JSON object and nothing else:',
    '```json',
    '{',
    '  "answer": "concise markdown answer for a glanceable HUD",',
    '  "citations": [{ "kind": "card|doc|email|message", "id": "...", "title": "...", "url": "...", "quote": "..." }],',
    '  "confidence": 0.0,',
    '  "suggestion": null',
    '}',
    '```',
    'For "suggestion", use null unless proposing a board change; if proposing, use:',
    '{ "summary": "...", "boardId": "...", "items": [{ "op": "create_card|move_card|update_card|comment_card", "payload": { ... }, "evidence": { "quote": "..." }, "confidence": 0.0 }] }',
  ].join('\n')
}

const SAFE_CITATION_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/**
 * Sanitizes a model-supplied citation URL before it is stored or rendered as an
 * anchor `href`. Returns the normalized href for an absolute http/https/mailto
 * URL, or `undefined` for anything else (script/data URLs, relative or
 * protocol-relative refs, malformed or non-string input). Never throws.
 */
export function sanitizeCitationUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  return SAFE_CITATION_SCHEMES.has(url.protocol) ? url.href : undefined
}

/**
 * Extracts the structured answer from the agent output. Tolerant: accepts a
 * fenced ```json block, a bare JSON object, or falls back to treating the whole
 * output as the answer text with no citations.
 */
export function parseDispatchAnswer(output: string): DispatchAnswer {
  const fallback: DispatchAnswer = {
    answer: output.trim(),
    citations: [],
    confidence: null,
    suggestion: null,
  }

  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : extractFirstJsonObject(output)
  if (!candidate) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback

  const obj = parsed as Record<string, unknown>
  const answer = typeof obj.answer === 'string' ? obj.answer : fallback.answer
  const citations = Array.isArray(obj.citations)
    ? obj.citations
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({
          kind: typeof c.kind === 'string' ? c.kind : 'unknown',
          id: typeof c.id === 'string' ? c.id : undefined,
          title: typeof c.title === 'string' ? c.title : undefined,
          url: sanitizeCitationUrl(c.url),
          quote: typeof c.quote === 'string' ? c.quote : undefined,
        }))
    : []
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : null

  let suggestion: DispatchAnswer['suggestion'] = null
  if (obj.suggestion && typeof obj.suggestion === 'object') {
    const s = obj.suggestion as Record<string, unknown>
    if (Array.isArray(s.items) && s.items.length > 0) {
      suggestion = {
        summary: typeof s.summary === 'string' ? s.summary : undefined,
        boardId: typeof s.boardId === 'string' ? s.boardId : undefined,
        items: s.items
          .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
          .map((i) => ({
            op: String(i.op),
            payload: (typeof i.payload === 'object' && i.payload !== null
              ? i.payload
              : {}) as Record<string, unknown>,
            targetCardId: typeof i.targetCardId === 'string' ? i.targetCardId : undefined,
            evidence:
              i.evidence && typeof i.evidence === 'object'
                ? { quote: String((i.evidence as Record<string, unknown>).quote ?? '') }
                : undefined,
            confidence: typeof i.confidence === 'number' ? i.confidence : undefined,
          })),
      }
    }
  }

  return { answer, citations, confidence, suggestion }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
