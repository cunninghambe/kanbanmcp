/**
 * M3 Integration Tests — graceful-fallback, path-escape, and missing-file paths.
 *
 * Spec: docs/specs/m3-deliverables-and-review-gate.md
 *   AC8  — missing DELIVERABLES line falls back to M2 behavior + warning comment
 *   AC9  — path-escape paths are rejected; safe paths still attach
 *   E1   — no DELIVERABLES line → M2 fallback
 *   E2   — listed file absent on disk → skipped, warning listed
 *   E3   — paths outside /deliverables/ rejected
 *   E4   — multiple deliverables, one fails → attach the rest, move to Review
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Transitive mocks (mirror m2-card-execute.test.ts requirements) ──────────

vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue({ userId: 'user-1', orgId: 'org-1', save: vi.fn() }) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {},
  RateLimitError: class extends Error { status = 429 },
  APIError: class extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))
vi.mock('pdf-parse', () => ({
  PDFParse: vi.fn(() => ({
    getText: vi.fn().mockResolvedValue({ text: '' }),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}))

// ─── Prisma mock ──────────────────────────────────────────────────────────────

const mockPrisma = {
  board: { findUnique: vi.fn() },
  card: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  column: { findUnique: vi.fn() },
  orgMember: { findUnique: vi.fn(), findMany: vi.fn() },
  cardExecution: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  comment: { create: vi.fn() },
  user: { findUnique: vi.fn() },
  $transaction: vi.fn(),
  apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
}

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

// ─── Deliverables mock ────────────────────────────────────────────────────────

vi.mock('../../src/lib/card-execution/deliverables', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/card-execution/deliverables')>()
  return {
    ...mod,
    parseDeliverableOutput: vi.fn(),
    resolveProjectPath: vi.fn(),
    attachDeliverableArtifact: vi.fn(),
    assertSafeDeliverablePath: vi.fn(),
  }
})

import * as deliverablesMod from '../../src/lib/card-execution/deliverables'

import {
  fireExecutionForCard,
  flushForTests,
  resetQueueForTests,
  __setMcpClientForTests,
} from '../../src/lib/card-execution/worker'

// ─── Types ────────────────────────────────────────────────────────────────────

type MockFn = ReturnType<typeof vi.fn>

type McpClient = {
  submitClaudeBuild: MockFn
  pollClaudeJobStatus: MockFn
  listClaudeProjects: MockFn
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COLS = {
  inProgress: { id: 'col-in-progress', name: 'In Progress', position: 1 },
  review:     { id: 'col-review',      name: 'Review',      position: 2 },
  done:       { id: 'col-done',        name: 'Done',        position: 3 },
  blocked:    { id: 'col-blocked',     name: 'Blocked',     position: 4 },
}

const ALL_COLS = Object.values(COLS)

const BOARD = {
  id: 'board-spoonworks',
  name: 'Spoonworks',
  orgId: 'org-1',
  columns: ALL_COLS,
}

function makeCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-abc12345',
    title: 'Write the quarterly plan',
    description: 'Produce a Q3 content strategy.',
    boardId: BOARD.id,
    columnId: COLS.inProgress.id,
    assigneeId: 'agent-claude-code',
    board: BOARD,
    column: COLS.inProgress,
    ...overrides,
  }
}

function makeExec(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-m3-1',
    cardId: 'card-abc12345',
    jobId: 'job-m3',
    state: 'running',
    project: 'spoonworks',
    branch: 'agent/card-bc12345',
    spec: 'Write the quarterly plan\n\nProduce a Q3 content strategy.',
    enqueuedAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    output: null,
    errorMessage: null,
    ...overrides,
  }
}

function makeMcp(pollOutput: string): McpClient {
  return {
    submitClaudeBuild: vi.fn().mockResolvedValue({ jobId: 'job-m3', state: 'enqueued' }),
    pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: pollOutput }),
    listClaudeProjects: vi.fn().mockResolvedValue(['spoonworks']),
  }
}

function allCommentContents(): string[] {
  return (mockPrisma.comment.create.mock.calls as Array<[{ data: { content: string } }]>).map(
    ([a]) => a.data.content,
  )
}

function cardMovedToColumn(columnId: string): boolean {
  return (mockPrisma.card.update.mock.calls as Array<[{ data: { columnId?: string } }]>).some(
    ([a]) => a.data.columnId === columnId,
  )
}

// ─── Shared lifecycle ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  resetQueueForTests()
  __setMcpClientForTests(null)
  mockPrisma.comment.create.mockResolvedValue({ id: 'cmt-1' })
  mockPrisma.card.update.mockResolvedValue({})
  mockPrisma.cardExecution.update.mockResolvedValue({ project: 'spoonworks' })
})

afterEach(() => {
  __setMcpClientForTests(null)
  resetQueueForTests()
})

// ─── Scenario A — Missing DELIVERABLES line (M2 fallback) [AC8, E1] ──────────

describe('Scenario A: missing DELIVERABLES line falls back to M2 behavior', () => {
  it('posts TWO comments (M2 fallback + M3 warning), moves card to Review, does not call attachDeliverableArtifact', async () => {
    // Given
    const blatherOutput = 'arbitrary Claude blather without the protocol block'

    mockPrisma.card.findUnique.mockResolvedValue(makeCard())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(makeExec({ jobId: null, state: 'enqueued' }))

    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValue({
      deliverables: [],
      summary: null,
      finalCommit: null,
      reviewUnconverged: false,
    })

    __setMcpClientForTests(makeMcp(blatherOutput))

    // When
    await fireExecutionForCard('card-abc12345')
    await flushForTests()

    // Then: card moved to Review
    expect(cardMovedToColumn(COLS.review.id)).toBe(true)

    // Then: exactly the M2 fallback comment present
    const comments = allCommentContents()
    const fallbackComment = comments.find((c) => c.includes('Claude Code finished.'))
    expect(fallbackComment).toBeDefined()
    expect(fallbackComment).toContain(blatherOutput.slice(0, 4000))

    // Then: exactly the M3 warning comment present
    const warningComment = comments.find((c) => c.includes('[M3 protocol warning]'))
    expect(warningComment).toBeDefined()

    // Then: TWO comments were posted (the fallback and the warning)
    const m3RelatedComments = comments.filter(
      (c) => c.includes('Claude Code finished.') || c.includes('[M3 protocol warning]'),
    )
    expect(m3RelatedComments).toHaveLength(2)

    // Then: no artifact attachment attempted
    expect(deliverablesMod.attachDeliverableArtifact).not.toHaveBeenCalled()
  })
})

// ─── Scenario B — Path-escape rejection [AC9, E3] ────────────────────────────

describe('Scenario B: path-escape paths are rejected; safe path still attaches', () => {
  it('calls attachDeliverableArtifact once (safe path), lists bad paths under Skipped or rejected, moves to Review', async () => {
    // Given
    const pollOutput = [
      'DELIVERABLES: /deliverables/good.md, ../etc/passwd, /etc/passwd',
      'SUMMARY: mixed bag',
      'FINAL COMMIT: sha',
    ].join('\n')

    mockPrisma.card.findUnique.mockResolvedValue(makeCard())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(makeExec({ jobId: null, state: 'enqueued' }))

    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValue({
      deliverables: ['/deliverables/good.md', '../etc/passwd', '/etc/passwd'],
      summary: 'mixed bag',
      finalCommit: 'sha',
      reviewUnconverged: false,
    })

    vi.mocked(deliverablesMod.resolveProjectPath).mockResolvedValue('/tmp/fake')

    vi.mocked(deliverablesMod.assertSafeDeliverablePath).mockImplementation((p: string) => {
      if (p === '../etc/passwd') {
        throw new Error('path must start with /deliverables/: ../etc/passwd')
      }
      if (p === '/etc/passwd') {
        throw new Error('path must start with /deliverables/: /etc/passwd')
      }
      // /deliverables/good.md passes silently
    })

    vi.mocked(deliverablesMod.attachDeliverableArtifact).mockResolvedValue({
      artifactId: 'art-1',
      filename: 'good.md',
    })

    __setMcpClientForTests(makeMcp(pollOutput))

    // When
    await fireExecutionForCard('card-abc12345')
    await flushForTests()

    // Then: only one attach call — the good path
    expect(deliverablesMod.attachDeliverableArtifact).toHaveBeenCalledTimes(1)
    expect(deliverablesMod.attachDeliverableArtifact).toHaveBeenCalledWith(
      'card-abc12345',
      '/tmp/fake',
      '/deliverables/good.md',
    )

    // Then: summary comment lists good.md under Attached and both bad paths under Skipped or rejected
    const comments = allCommentContents()
    const summaryComment = comments.find((c) => c.includes('Claude Code delivered:'))
    expect(summaryComment).toBeDefined()
    expect(summaryComment).toContain('**Attached:**')
    expect(summaryComment).toContain('good.md')
    expect(summaryComment).toContain('**Skipped or rejected:**')
    expect(summaryComment).toContain('../etc/passwd')
    expect(summaryComment).toContain('/etc/passwd')

    // Then: card moved to Review
    expect(cardMovedToColumn(COLS.review.id)).toBe(true)

    // Then: CardExecution not in a failed state
    const failedUpdates = (mockPrisma.cardExecution.update.mock.calls as Array<[{ data: { state?: string } }]>).filter(
      ([a]) => a.data.state === 'failed',
    )
    expect(failedUpdates).toHaveLength(0)
  })
})

// ─── Scenario C — Multiple deliverables, one missing on disk [E2, E4] ────────

describe('Scenario C: multiple deliverables — one missing on disk is skipped', () => {
  it('lists found.md under Attached and missing.md under Skipped or rejected; card moves to Review', async () => {
    // Given
    const pollOutput = [
      'DELIVERABLES: /deliverables/found.md, /deliverables/missing.md',
      'SUMMARY: two files',
      'FINAL COMMIT: sha',
    ].join('\n')

    mockPrisma.card.findUnique.mockResolvedValue(makeCard())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(makeExec({ jobId: null, state: 'enqueued' }))

    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValue({
      deliverables: ['/deliverables/found.md', '/deliverables/missing.md'],
      summary: 'two files',
      finalCommit: 'sha',
      reviewUnconverged: false,
    })

    vi.mocked(deliverablesMod.resolveProjectPath).mockResolvedValue('/tmp/fake')

    // Both paths pass the safety check
    vi.mocked(deliverablesMod.assertSafeDeliverablePath).mockImplementation((_p: string) => {
      // no-op: both paths are safe
    })

    vi.mocked(deliverablesMod.attachDeliverableArtifact)
      .mockResolvedValueOnce({ artifactId: 'art-1', filename: 'found.md' })
      .mockResolvedValueOnce({ skipped: 'missing' })

    __setMcpClientForTests(makeMcp(pollOutput))

    // When
    await fireExecutionForCard('card-abc12345')
    await flushForTests()

    // Then: both attach calls were made
    expect(deliverablesMod.attachDeliverableArtifact).toHaveBeenCalledTimes(2)

    // Then: summary comment lists found.md under Attached
    const comments = allCommentContents()
    const summaryComment = comments.find((c) => c.includes('Claude Code delivered:'))
    expect(summaryComment).toBeDefined()
    expect(summaryComment).toContain('**Attached:**')
    expect(summaryComment).toContain('found.md')

    // Then: missing.md listed under Skipped or rejected with its reason
    expect(summaryComment).toContain('**Skipped or rejected:**')
    expect(summaryComment).toContain('/deliverables/missing.md')
    expect(summaryComment).toContain('missing')

    // Then: card moved to Review
    expect(cardMovedToColumn(COLS.review.id)).toBe(true)
  })
})
