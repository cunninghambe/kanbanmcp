/**
 * Unit tests for src/lib/card-execution/deliverables.ts — parseDeliverableOutput
 *
 * The module under test does NOT exist yet. These tests will fail to import
 * until the paired coder task creates the file. That is the correct TDD state.
 *
 * Spec coverage: AC2, AC5, AC7, AC8 / E1, E5
 * Interface contract: OUTPUT PROTOCOL block (three trailing lines, exact format)
 */
import { describe, it, expect } from 'vitest'
import {
  parseDeliverableOutput,
} from '../../src/lib/card-execution/deliverables'
import type { ParsedDeliverableOutput } from '../../src/lib/card-execution/deliverables'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ABSENT: ParsedDeliverableOutput = {
  deliverables: [],
  summary: null,
  finalCommit: null,
  reviewUnconverged: false,
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('parseDeliverableOutput', () => {
  // ── Test 1 ──────────────────────────────────────────────────────────────────
  it('happy path — parses two deliverables, summary, and commit hash', () => {
    // Given
    const output = [
      'Some agent preamble here.',
      '',
      'DELIVERABLES: /deliverables/plan.md, /deliverables/model.xlsx',
      'SUMMARY: A 3-channel content plan with quarterly forecasts.',
      'FINAL COMMIT: abc123',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then
    expect(result).toEqual<ParsedDeliverableOutput>({
      deliverables: ['/deliverables/plan.md', '/deliverables/model.xlsx'],
      summary: 'A 3-channel content plan with quarterly forecasts.',
      finalCommit: 'abc123',
      reviewUnconverged: false,
    })
  })

  // ── Test 2 ──────────────────────────────────────────────────────────────────
  it('single deliverable with no trailing whitespace on any line', () => {
    // Given
    const output = 'DELIVERABLES: /deliverables/x.md\nSUMMARY: ok\nFINAL COMMIT: deadbeef'

    // When
    const result = parseDeliverableOutput(output)

    // Then
    expect(result).toEqual<ParsedDeliverableOutput>({
      deliverables: ['/deliverables/x.md'],
      summary: 'ok',
      finalCommit: 'deadbeef',
      reviewUnconverged: false,
    })
  })

  // ── Test 3 ──────────────────────────────────────────────────────────────────
  it('multi-line summary — all three lines preserved', () => {
    // Given
    // The spec says SUMMARY content spans multiple lines terminated by FINAL COMMIT.
    // The parser must collect everything between SUMMARY: and the FINAL COMMIT: line.
    const output = [
      'DELIVERABLES: /deliverables/report.md',
      'SUMMARY: Line one of the summary.',
      'Line two of the summary.',
      'Line three of the summary.',
      'FINAL COMMIT: f00dcafe',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then
    expect(result.summary).toBe(
      'Line one of the summary.\nLine two of the summary.\nLine three of the summary.'
    )
    expect(result.finalCommit).toBe('f00dcafe')
    expect(result.reviewUnconverged).toBe(false)
  })

  // ── Test 4 ──────────────────────────────────────────────────────────────────
  it('UNCONVERGED prefix — sets reviewUnconverged=true, preserves prefix in summary (AC7, E5)', () => {
    // Given — spec §E5: prepend "[REVIEW UNCONVERGED] " to summary content
    const output = [
      'DELIVERABLES: /deliverables/draft.md',
      'SUMMARY: [REVIEW UNCONVERGED] still missing cost section, committed anyway.',
      'FINAL COMMIT: badf00d1',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then
    expect(result.reviewUnconverged).toBe(true)
    // The full summary text including the prefix must be preserved verbatim
    expect(result.summary).toBe(
      '[REVIEW UNCONVERGED] still missing cost section, committed anyway.'
    )
    expect(result.finalCommit).toBe('badf00d1')
  })

  // ── Test 5 ──────────────────────────────────────────────────────────────────
  it('trailing whitespace and newlines after FINAL COMMIT line are tolerated', () => {
    // Given
    const output = [
      'DELIVERABLES: /deliverables/plan.md, /deliverables/model.xlsx',
      'SUMMARY: A 3-channel content plan with quarterly forecasts.',
      'FINAL COMMIT: abc123',
      '',
      '   ',
      '',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then
    expect(result).toEqual<ParsedDeliverableOutput>({
      deliverables: ['/deliverables/plan.md', '/deliverables/model.xlsx'],
      summary: 'A 3-channel content plan with quarterly forecasts.',
      finalCommit: 'abc123',
      reviewUnconverged: false,
    })
  })

  // ── Test 6 ──────────────────────────────────────────────────────────────────
  it('preamble before the protocol block is ignored — parser anchors to end of output', () => {
    // Given — large preamble that could confuse a naive line-scanner
    const preamble = [
      'I am going to produce the deliverable now.',
      'DELIVERABLES: /deliverables/fake.md',
      'SUMMARY: this is not the real block',
      '',
      'Here is a long analysis section...',
      'More text.',
    ].join('\n')

    const protocolBlock = [
      'DELIVERABLES: /deliverables/real.md',
      'SUMMARY: The real summary.',
      'FINAL COMMIT: 1a2b3c4d',
    ].join('\n')

    const output = preamble + '\n' + protocolBlock

    // When
    const result = parseDeliverableOutput(output)

    // Then — only the trailing block counts
    expect(result.deliverables).toEqual(['/deliverables/real.md'])
    expect(result.summary).toBe('The real summary.')
    expect(result.finalCommit).toBe('1a2b3c4d')
  })

  // ── Test 7 ──────────────────────────────────────────────────────────────────
  it('missing DELIVERABLES line → absent result (E1, AC8)', () => {
    // Given — output has SUMMARY and FINAL COMMIT but no DELIVERABLES line
    const output = [
      'Some output.',
      'SUMMARY: A summary without the deliverables header.',
      'FINAL COMMIT: aaaabbbb',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then — the whole block is considered absent
    expect(result).toEqual(ABSENT)
  })

  // ── Test 8a ─────────────────────────────────────────────────────────────────
  it('comma spacing variant — no spaces between paths — each path trimmed', () => {
    // Given
    const output = [
      'DELIVERABLES: /deliverables/a.md,/deliverables/b.md',
      'SUMMARY: Two files.',
      'FINAL COMMIT: cafe0001',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then
    expect(result.deliverables).toEqual(['/deliverables/a.md', '/deliverables/b.md'])
  })

  // ── Test 8b ─────────────────────────────────────────────────────────────────
  it('comma spacing variant — extra spaces around paths — each path trimmed', () => {
    // Given
    const output = [
      'DELIVERABLES: /deliverables/a.md , /deliverables/b.md ',
      'SUMMARY: Two files.',
      'FINAL COMMIT: cafe0002',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then
    expect(result.deliverables).toEqual(['/deliverables/a.md', '/deliverables/b.md'])
  })

  // ── Test 9 ──────────────────────────────────────────────────────────────────
  it('empty DELIVERABLES value — deliverables array is empty', () => {
    // Given — DELIVERABLES line present but value is blank
    const output = [
      'DELIVERABLES: ',
      'SUMMARY: Nothing to attach.',
      'FINAL COMMIT: 00000000',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then
    expect(result.deliverables).toEqual([])
    expect(result.summary).toBe('Nothing to attach.')
    expect(result.finalCommit).toBe('00000000')
    expect(result.reviewUnconverged).toBe(false)
  })

  // ── Test 10 ─────────────────────────────────────────────────────────────────
  it('wrong order (reversed protocol lines) → absent result', () => {
    // Given — spec requires DELIVERABLES, SUMMARY, FINAL COMMIT in that exact order
    const output = [
      'FINAL COMMIT: abcdef01',
      'SUMMARY: Summary first.',
      'DELIVERABLES: /deliverables/x.md',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then — out-of-order block is not a valid protocol block
    expect(result).toEqual(ABSENT)
  })

  // ── Bonus: completely empty input ────────────────────────────────────────────
  it('empty string → absent result', () => {
    expect(parseDeliverableOutput('')).toEqual(ABSENT)
  })

  // ── AC5 sentinel ─────────────────────────────────────────────────────────────
  // Explicit AC5 guard: reviewer PASS on round 1 — no prefix in summary, reviewUnconverged=false.
  it('AC5 — reviewer PASS, no prefix: reviewUnconverged is false and summary starts naturally', () => {
    // Given — round-1 PASS output; summary has no [REVIEW UNCONVERGED] marker
    const output = [
      'DELIVERABLES: /deliverables/summary.md',
      'SUMMARY: A comprehensive 1-page summary covering all key points.',
      'FINAL COMMIT: 1234abcd',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then
    expect(result.reviewUnconverged).toBe(false)
    expect(result.summary).toBe('A comprehensive 1-page summary covering all key points.')
    // Summary must NOT start with the unconverged marker
    expect(result.summary?.startsWith('[REVIEW UNCONVERGED]')).toBe(false)
  })

  // ── AC7 multi-line UNCONVERGED ────────────────────────────────────────────────
  // Spec §E5: prefix on line 1, more notes on lines 2-3, then FINAL COMMIT.
  // All lines preserved; prefix detected.
  it('AC7 — multi-line UNCONVERGED summary: prefix detected, all lines preserved verbatim', () => {
    // Given
    const output = [
      'DELIVERABLES: /deliverables/draft.md',
      'SUMMARY: [REVIEW UNCONVERGED] still missing cost section.',
      'Reviewer noted: numbers not cited.',
      'Committed best-effort version after 3 rounds.',
      'FINAL COMMIT: deadcafe',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then — prefix detected
    expect(result.reviewUnconverged).toBe(true)
    // All three summary lines preserved, joined with newlines
    expect(result.summary).toBe(
      '[REVIEW UNCONVERGED] still missing cost section.\nReviewer noted: numbers not cited.\nCommitted best-effort version after 3 rounds.'
    )
    expect(result.finalCommit).toBe('deadcafe')
  })

  // ── AC7 negative: prefix NOT at start of summary ──────────────────────────────
  // The [REVIEW UNCONVERGED] marker must appear at the very start of the summary
  // value. If it appears elsewhere in the text, reviewUnconverged must remain false.
  it('AC7 negative — prefix buried mid-summary: reviewUnconverged remains false', () => {
    // Given — marker present but not at position 0 of the summary string
    const output = [
      'DELIVERABLES: /deliverables/report.md',
      'SUMMARY: All sections complete. Note: [REVIEW UNCONVERGED] was flagged in draft.',
      'FINAL COMMIT: cafebabe',
    ].join('\n')

    // When
    const result = parseDeliverableOutput(output)

    // Then — the mid-body occurrence must NOT set reviewUnconverged
    expect(result.reviewUnconverged).toBe(false)
    expect(result.summary).toBe(
      'All sections complete. Note: [REVIEW UNCONVERGED] was flagged in draft.'
    )
  })
})
