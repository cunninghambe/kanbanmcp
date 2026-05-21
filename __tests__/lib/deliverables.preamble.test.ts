/**
 * Unit tests for DELIVERABLE_SPEC_PREAMBLE and buildEnrichedSpec (M3 Task 4 — TDD)
 *
 * The module under test does NOT exist yet. These tests will fail to import
 * until @coder implements the exports in deliverables.ts. That is the correct
 * TDD state.
 *
 * These tests are intentionally brittle. DELIVERABLE_SPEC_PREAMBLE is
 * load-bearing: Claude reads it literally. If any word drifts, the test
 * should fail immediately to surface the change.
 *
 * Spec coverage: AC6, AC10 / Interface contract §Enriched spec text
 *
 * Exports under test (from src/lib/card-execution/deliverables):
 *   export const DELIVERABLE_SPEC_PREAMBLE: string
 *   export function buildEnrichedSpec(title: string, description: string): string
 */
import { describe, it, expect } from 'vitest'

import {
  DELIVERABLE_SPEC_PREAMBLE,
  buildEnrichedSpec,
} from '../../src/lib/card-execution/deliverables'

// ---------------------------------------------------------------------------
// DELIVERABLE_SPEC_PREAMBLE — golden content tests
// ---------------------------------------------------------------------------

describe('DELIVERABLE_SPEC_PREAMBLE', () => {
  it('contains the literal section header "DELIVERABLE REQUIREMENTS"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('DELIVERABLE REQUIREMENTS')
  })

  it('contains the literal section header "PRE-COMMIT REVIEW GATE"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('PRE-COMMIT REVIEW GATE')
  })

  it('contains the literal section header "OUTPUT PROTOCOL"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('OUTPUT PROTOCOL')
  })

  it('contains the output protocol marker "DELIVERABLES:"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('DELIVERABLES:')
  })

  it('contains the output protocol marker "SUMMARY:"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('SUMMARY:')
  })

  it('contains the output protocol marker "FINAL COMMIT:"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('FINAL COMMIT:')
  })

  it('contains the venv path ".venv-agent/"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('.venv-agent/')
  })

  it('contains the literal text "Maximum 3 review rounds"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('Maximum 3 review rounds')
  })

  it('contains the unconverged summary prefix "[REVIEW UNCONVERGED]"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('[REVIEW UNCONVERGED]')
  })

  it('mentions the .md deliverable format', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('.md')
  })

  it('mentions the .html deliverable format', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('.html')
  })

  it('mentions the .xlsx deliverable format', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('.xlsx')
  })

  it('mentions the .pptx deliverable format', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('.pptx')
  })

  it('mentions the .docx deliverable format', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('.docx')
  })

  it('mentions the .csv deliverable format', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('.csv')
  })

  it('mentions the .json deliverable format', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('.json')
  })

  it('contains the uv venv bootstrap command "uv venv .venv-agent"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('uv venv .venv-agent')
  })

  it('contains the uv pip install command "uv pip install"', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('uv pip install')
  })

  it('contains the reviewer subagent spawning instruction referencing the Agent tool', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('Agent tool')
  })

  it('contains the JSON verdict shape instruction with "PASS"|"REVISE" literal', () => {
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('"PASS"')
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('"REVISE"')
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('"verdict"')
    expect(DELIVERABLE_SPEC_PREAMBLE).toContain('"notes"')
  })
})

// ---------------------------------------------------------------------------
// buildEnrichedSpec
// ---------------------------------------------------------------------------

describe('buildEnrichedSpec', () => {
  it('returns title, then blank line, then description, then separator, then preamble', () => {
    const title = 'Write a Q2 sales strategy'
    const description = 'Focus on EMEA expansion and mid-market segment.'

    const result = buildEnrichedSpec(title, description)

    expect(result).toBe(
      `${title}\n\n${description}\n\n---\n${DELIVERABLE_SPEC_PREAMBLE}`,
    )
  })

  it('empty description produces two consecutive newlines between empty desc and separator', () => {
    const title = 'Empty desc card'
    const description = ''

    const result = buildEnrichedSpec(title, description)

    expect(result).toBe(`${title}\n\n\n\n---\n${DELIVERABLE_SPEC_PREAMBLE}`)
  })

  it('returns the same string for identical inputs (idempotent)', () => {
    const title = 'Stability check'
    const description = 'Same inputs, same output.'

    const first = buildEnrichedSpec(title, description)
    const second = buildEnrichedSpec(title, description)

    expect(first).toBe(second)
  })
})
