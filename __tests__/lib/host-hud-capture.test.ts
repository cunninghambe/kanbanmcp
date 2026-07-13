import { describe, it, expect } from 'vitest'
import { parseCapture } from '../../src/lib/host-hud/capture'

// now = Monday, 2026-07-13 10:00 local time. Used by every case below so the
// "next weekday" and today/tomorrow arithmetic is deterministic.
const NOW = new Date('2026-07-13T10:00:00')

function ymd(date: Date | null): string | null {
  if (!date) return null
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

describe('parseCapture', () => {
  it('POSITIVE: extracts assignee and due:weekday, leaves the rest as residual text', () => {
    const result = parseCapture('@brad send contract due:fri', NOW)
    expect(result.text).toBe('send contract')
    expect(result.assigneeQuery).toBe('brad')
    expect(ymd(result.dueDate)).toBe('2026-07-17')
  })

  it('POSITIVE: extracts due:YYYY-MM-DD with no assignee', () => {
    const result = parseCapture('due:2026-08-01 ship the deck', NOW)
    expect(result.text).toBe('ship the deck')
    expect(result.assigneeQuery).toBeNull()
    expect(ymd(result.dueDate)).toBe('2026-08-01')
  })

  it('POSITIVE: extracts due:tomorrow and a mention regardless of order in the string', () => {
    const result = parseCapture('due:tomorrow @Nadia review', NOW)
    expect(result.text).toBe('review')
    expect(result.assigneeQuery).toBe('Nadia')
    expect(ymd(result.dueDate)).toBe('2026-07-14')
  })

  it('NEGATIVE (FP boundary): a mid-word @ in an email address is not a mention', () => {
    const result = parseCapture('email brad@a1.dev about budget', NOW)
    expect(result.assigneeQuery).toBeNull()
    expect(result.text).toBe('email brad@a1.dev about budget')
  })

  it('NEGATIVE: an unrecognized due: form stays in the text', () => {
    const result = parseCapture('the deadline is due:someday', NOW)
    expect(result.dueDate).toBeNull()
    expect(result.text).toBe('the deadline is due:someday')
  })

  it('NEGATIVE: a bare @ with no following word char is not a token', () => {
    const result = parseCapture('costs @ 5 dollars', NOW)
    expect(result.assigneeQuery).toBeNull()
    expect(result.text).toBe('costs @ 5 dollars')
  })

  it('EDGE: an invalid calendar date is not recognized and stays in the text', () => {
    const result = parseCapture('due:2026-13-45 fix dates', NOW)
    expect(result.dueDate).toBeNull()
    expect(result.text).toBe('due:2026-13-45 fix dates')
  })

  it('EDGE: due:mon on a Monday resolves to the NEXT Monday, not today', () => {
    const result = parseCapture('due:mon standup', NOW)
    expect(ymd(result.dueDate)).toBe('2026-07-20')
    expect(result.text).toBe('standup')
  })

  it('EDGE: only the first @mention is extracted; later ones stay in the text', () => {
    const result = parseCapture('@brad @nadia pair on this', NOW)
    expect(result.assigneeQuery).toBe('brad')
    expect(result.text).toBe('@nadia pair on this')
  })

  it('EDGE: only the first due: token is used; the second stays in the text', () => {
    const result = parseCapture('due:fri due:mon call', NOW)
    expect(ymd(result.dueDate)).toBe('2026-07-17')
    expect(result.text).toBe('due:mon call')
  })

  it('DEGRADATION: empty and whitespace-only input parse to empty residual text', () => {
    expect(parseCapture('', NOW)).toEqual({ text: '', assigneeQuery: null, dueDate: null })
    expect(parseCapture('   ', NOW)).toEqual({ text: '', assigneeQuery: null, dueDate: null })
  })

  it('DEGRADATION: input that is entirely tokens leaves empty residual text (parser does not throw)', () => {
    const result = parseCapture('@brad due:fri', NOW)
    expect(result.text).toBe('')
    expect(result.assigneeQuery).toBe('brad')
    expect(ymd(result.dueDate)).toBe('2026-07-17')
  })

  it('DEGRADATION: interior and surrounding whitespace collapses to single spaces, trimmed', () => {
    const result = parseCapture('  @brad   send    it  ', NOW)
    expect(result.text).toBe('send it')
  })
})
