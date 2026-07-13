import { describe, it, expect } from 'vitest'
import {
  buildDispatchPrompt,
  parseDispatchAnswer,
  isDispatchTarget,
  sanitizeCitationUrl,
} from '../../src/lib/host-hud/dispatch'

describe('isDispatchTarget', () => {
  it('accepts the four supported targets and rejects others', () => {
    expect(isDispatchTarget('board')).toBe(true)
    expect(isDispatchTarget('drive')).toBe(true)
    expect(isDispatchTarget('email')).toBe(true)
    expect(isDispatchTarget('slack')).toBe(true)
    expect(isDispatchTarget('youtube')).toBe(false)
    expect(isDispatchTarget(42)).toBe(false)
  })
})

describe('buildDispatchPrompt', () => {
  it('embeds the question, target guidance, READ-ONLY rules, and optional context', () => {
    const prompt = buildDispatchPrompt({
      target: 'drive',
      question: 'where is the contract?',
      context: 'CTX-MARKER',
    })
    expect(prompt).toContain('READ-ONLY')
    expect(prompt).toContain('where is the contract?')
    expect(prompt).toMatch(/Google Drive/i)
    expect(prompt).toContain('CTX-MARKER')
    expect(prompt).toContain('"suggestion"')
  })

  it('omits the context block when none is provided', () => {
    const prompt = buildDispatchPrompt({ target: 'board', question: 'q' })
    expect(prompt).not.toContain('CONTEXT (read-only)')
  })
})

describe('parseDispatchAnswer', () => {
  it('parses a fenced json block with citations and confidence', () => {
    const out = [
      'Here you go:',
      '```json',
      JSON.stringify({
        answer: 'Three cards are overdue.',
        citations: [{ kind: 'card', id: 'c1', title: 'Ship it' }],
        confidence: 0.9,
        suggestion: null,
      }),
      '```',
    ].join('\n')
    const parsed = parseDispatchAnswer(out)
    expect(parsed.answer).toBe('Three cards are overdue.')
    expect(parsed.citations).toHaveLength(1)
    expect(parsed.citations[0].id).toBe('c1')
    expect(parsed.confidence).toBe(0.9)
    expect(parsed.suggestion).toBeNull()
  })

  it('parses a bare json object with no fence', () => {
    const parsed = parseDispatchAnswer('{"answer":"hi","citations":[],"confidence":null}')
    expect(parsed.answer).toBe('hi')
    expect(parsed.confidence).toBeNull()
  })

  it('extracts a suggestion with items', () => {
    const out = JSON.stringify({
      answer: 'I suggest moving it.',
      citations: [],
      confidence: 0.7,
      suggestion: {
        summary: 'move card to done',
        boardId: 'b1',
        items: [{ op: 'move_card', payload: { cardId: 'c1', columnId: 'done', position: 1 } }],
      },
    })
    const parsed = parseDispatchAnswer(out)
    expect(parsed.suggestion).not.toBeNull()
    expect(parsed.suggestion?.items[0].op).toBe('move_card')
    expect(parsed.suggestion?.boardId).toBe('b1')
  })

  it('falls back to raw text when there is no JSON', () => {
    const parsed = parseDispatchAnswer('just a plain answer')
    expect(parsed.answer).toBe('just a plain answer')
    expect(parsed.citations).toEqual([])
    expect(parsed.suggestion).toBeNull()
  })

  it('strips an unsafe javascript: citation url to undefined', () => {
    const parsed = parseDispatchAnswer(
      JSON.stringify({
        answer: 'see link',
        citations: [{ kind: 'doc', title: 'evil', url: 'javascript:alert(1)' }],
        confidence: null,
        suggestion: null,
      })
    )
    expect(parsed.citations).toHaveLength(1)
    expect(parsed.citations[0].url).toBeUndefined()
    expect(parsed.citations[0].title).toBe('evil')
  })

  it('keeps a safe https citation url intact', () => {
    const parsed = parseDispatchAnswer(
      JSON.stringify({
        answer: 'a',
        citations: [{ kind: 'doc', title: 't', url: 'https://example.com/doc' }],
        confidence: null,
        suggestion: null,
      })
    )
    expect(parsed.citations[0].url).toBe('https://example.com/doc')
  })
})

describe('sanitizeCitationUrl', () => {
  // POSITIVE — safe, allow-listed absolute URLs pass through.
  it('passes http, https, and mailto absolute URLs', () => {
    expect(sanitizeCitationUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(sanitizeCitationUrl('http://example.com')).toBe('http://example.com/')
    expect(sanitizeCitationUrl('mailto:legal@example.com')).toBe('mailto:legal@example.com')
  })

  // NEGATIVE — the FP boundary: script/data/other schemes and non-absolute refs.
  it('rejects dangerous or non-allow-listed URL forms', () => {
    expect(sanitizeCitationUrl('javascript:alert(1)')).toBeUndefined()
    expect(sanitizeCitationUrl('data:text/html,<script>1</script>')).toBeUndefined()
    expect(sanitizeCitationUrl('vbscript:msgbox(1)')).toBeUndefined()
    expect(sanitizeCitationUrl('file:///etc/passwd')).toBeUndefined()
    expect(sanitizeCitationUrl('/relative/path')).toBeUndefined()
    expect(sanitizeCitationUrl('//protocol-relative.example.com')).toBeUndefined()
    expect(sanitizeCitationUrl('ftp://example.com/x')).toBeUndefined()
  })

  // EDGE — whitespace, uppercase scheme, embedded control chars.
  it('trims surrounding whitespace and accepts case-insensitive schemes', () => {
    expect(sanitizeCitationUrl('  https://example.com/x  ')).toBe('https://example.com/x')
    expect(sanitizeCitationUrl('HTTPS://Example.com/Path')).toBe('https://example.com/Path')
    // A leading control char before the scheme must not sneak past parsing.
    expect(sanitizeCitationUrl('\tjavascript:alert(1)')).toBeUndefined()
  })

  // DEGRADED — malformed / non-string inputs never throw; always undefined.
  it('returns undefined for empty and non-string inputs', () => {
    expect(sanitizeCitationUrl('')).toBeUndefined()
    expect(sanitizeCitationUrl('   ')).toBeUndefined()
    expect(sanitizeCitationUrl('not a url')).toBeUndefined()
    expect(sanitizeCitationUrl(null)).toBeUndefined()
    expect(sanitizeCitationUrl(undefined)).toBeUndefined()
    expect(sanitizeCitationUrl(42)).toBeUndefined()
    expect(sanitizeCitationUrl({})).toBeUndefined()
  })
})
