/**
 * M3 Integration Tests — full e2e success path with multiple deliverables.
 * Task 8 TDD: tests defined before implementation ships.
 *
 * Spec: docs/specs/m3-deliverables-and-review-gate.md
 * Coverage:
 *   AC2  — summary comment (not raw output)
 *   AC3  — multiple deliverables as separate artifacts
 *   AC11 — no DB schema migration required (Prisma compile-time sentinel)
 *   T5   — no M2 "Claude Code finished." fallback when M3 protocol present
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Transitive mock requirements ────────────────────────────────────────────

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
    parseDeliverableOutput: vi.fn().mockReturnValue({
      deliverables: [],
      summary: null,
      finalCommit: null,
      reviewUnconverged: false,
    }),
    resolveProjectPath: vi.fn().mockResolvedValue(null),
    attachDeliverableArtifact: vi.fn().mockResolvedValue({ skipped: 'missing' }),
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
  backlog:    { id: 'col-backlog',     name: 'Backlog',      position: 0 },
  inProgress: { id: 'col-in-progress', name: 'In Progress',  position: 1 },
  review:     { id: 'col-review',      name: 'Review',       position: 2 },
  done:       { id: 'col-done',        name: 'Done',         position: 3 },
  blocked:    { id: 'col-blocked',     name: 'Blocked',      position: 4 },
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
    id: 'card-m3abc1234',
    title: 'Forecast model + companion summary',
    description: 'Build a 3-channel forecast model with a companion summary document.',
    boardId: BOARD.id,
    columnId: COLS.inProgress.id,
    assigneeId: 'agent-claude-code',
    board: { ...BOARD, columns: [...ALL_COLS] },
    column: COLS.inProgress,
    ...overrides,
  }
}

function makeExec(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-m3-001',
    cardId: 'card-m3abc1234',
    jobId: 'job-m3-xyz',
    state: 'running',
    project: 'spoonworks',
    branch: 'agent/card-3abc1234',
    spec: 'Forecast model + companion summary\n\nBuild a 3-channel forecast model.',
    enqueuedAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    output: null,
    errorMessage: null,
    ...overrides,
  }
}

const M3_OUTPUT = [
  'I have completed the forecast model and companion summary.',
  'Both files have passed the pre-commit review gate (1 round).',
  '',
  'DELIVERABLES: /deliverables/model.xlsx, /deliverables/summary.md',
  'SUMMARY: Built a 3-channel forecast model with companion summary.',
  'FINAL COMMIT: abc123',
].join('\n')

function makeMcp(overrides: Partial<McpClient> = {}): McpClient {
  return {
    submitClaudeBuild: vi.fn().mockResolvedValue({ jobId: 'job-m3-xyz', state: 'enqueued' }),
    pollClaudeJobStatus: vi.fn()
      .mockResolvedValueOnce({ state: 'running' })
      .mockResolvedValueOnce({ state: 'done', exitCode: 0, output: M3_OUTPUT }),
    listClaudeProjects: vi.fn().mockResolvedValue(['spoonworks']),
    ...overrides,
  }
}

function commentCalls(): Array<{ content: string; userId: string; cardId: string }> {
  return (mockPrisma.comment.create.mock.calls as Array<[{ data: { content: string; userId: string; cardId: string } }]>)
    .map(([a]) => a.data)
}

function cardUpdateCalls(): Array<{ columnId?: string }> {
  return (mockPrisma.card.update.mock.calls as Array<[{ data: { columnId?: string } }]>)
    .map(([a]) => a.data)
}

function execUpdateStates(): Array<string | undefined> {
  return (mockPrisma.cardExecution.update.mock.calls as Array<[{ data: { state?: string } }]>)
    .map(([a]) => a.data.state)
    .filter(Boolean)
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  resetQueueForTests()
  __setMcpClientForTests(null)
  mockPrisma.comment.create.mockResolvedValue({ id: 'comment-1' })
  mockPrisma.card.update.mockResolvedValue({})
  mockPrisma.cardExecution.update.mockResolvedValue({ project: 'spoonworks' })
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma)
  )
})

afterEach(() => {
  vi.useRealTimers()
  __setMcpClientForTests(null)
  resetQueueForTests()
})

// ─────────────────────────────────────────────────────────────────────────────
// M3 e2e: two deliverables, both attached, single summary comment
// ─────────────────────────────────────────────────────────────────────────────

describe('M3 e2e — two deliverables, both attached, single summary comment', () => {
  beforeEach(() => {
    const execRow = makeExec({ state: 'enqueued', jobId: null })

    mockPrisma.card.findUnique.mockResolvedValue(makeCard())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(execRow)
    mockPrisma.cardExecution.update.mockResolvedValue({ ...execRow, jobId: 'job-m3-xyz', project: 'spoonworks' })

    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValue({
      deliverables: ['/deliverables/model.xlsx', '/deliverables/summary.md'],
      summary: 'Built a 3-channel forecast model with companion summary.',
      finalCommit: 'abc123',
      reviewUnconverged: false,
    })
    vi.mocked(deliverablesMod.resolveProjectPath).mockResolvedValue('/tmp/fake-project')
    vi.mocked(deliverablesMod.attachDeliverableArtifact)
      .mockResolvedValueOnce({ artifactId: 'art-1', filename: 'model.xlsx' })
      .mockResolvedValueOnce({ artifactId: 'art-2', filename: 'summary.md' })
    vi.mocked(deliverablesMod.assertSafeDeliverablePath).mockReturnValue(undefined)

    __setMcpClientForTests(makeMcp())
  })

  it('assertSafeDeliverablePath is called once per deliverable path', async () => {
    await fireExecutionForCard('card-m3abc1234')
    await vi.runAllTimersAsync()
    await flushForTests()

    expect(deliverablesMod.assertSafeDeliverablePath).toHaveBeenCalledTimes(2)
    expect(deliverablesMod.assertSafeDeliverablePath).toHaveBeenCalledWith('/deliverables/model.xlsx')
    expect(deliverablesMod.assertSafeDeliverablePath).toHaveBeenCalledWith('/deliverables/summary.md')
  })

  it('attachDeliverableArtifact is called once per deliverable with correct paths', async () => {
    await fireExecutionForCard('card-m3abc1234')
    await vi.runAllTimersAsync()
    await flushForTests()

    expect(deliverablesMod.attachDeliverableArtifact).toHaveBeenCalledTimes(2)
    expect(deliverablesMod.attachDeliverableArtifact).toHaveBeenCalledWith(
      'card-m3abc1234',
      '/tmp/fake-project',
      '/deliverables/model.xlsx',
    )
    expect(deliverablesMod.attachDeliverableArtifact).toHaveBeenCalledWith(
      'card-m3abc1234',
      '/tmp/fake-project',
      '/deliverables/summary.md',
    )
  })

  it('posts exactly one summary comment containing the header, summary text, and both filenames', async () => {
    await fireExecutionForCard('card-m3abc1234')
    await vi.runAllTimersAsync()
    await flushForTests()

    const deliveryComments = commentCalls().filter((c) => c.content.includes('**Claude Code delivered:**'))
    expect(deliveryComments).toHaveLength(1)

    const { content } = deliveryComments[0]
    expect(content).toContain('**Claude Code delivered:**')
    expect(content).toContain('Built a 3-channel forecast model with companion summary.')
    expect(content).toContain('model.xlsx')
    expect(content).toContain('summary.md')
  })

  it('card moves to Review column', async () => {
    await fireExecutionForCard('card-m3abc1234')
    await vi.runAllTimersAsync()
    await flushForTests()

    const moveToReview = cardUpdateCalls().find((d) => d.columnId === COLS.review.id)
    expect(moveToReview).toBeDefined()
  })

  it('CardExecution updated to state=done', async () => {
    await fireExecutionForCard('card-m3abc1234')
    await vi.runAllTimersAsync()
    await flushForTests()

    expect(execUpdateStates()).toContain('done')
  })

  it('no [M3 protocol warning] comment is posted', async () => {
    await fireExecutionForCard('card-m3abc1234')
    await vi.runAllTimersAsync()
    await flushForTests()

    const warningComment = commentCalls().find((c) => c.content.includes('M3 protocol warning'))
    expect(warningComment).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M3 e2e backward-compat: no M2 "Claude Code finished." when M3 protocol present
// ─────────────────────────────────────────────────────────────────────────────

describe('M3 backward-compat — M2 fallback comment absent when M3 protocol is present', () => {
  it('does not post "Claude Code finished." when parseDeliverableOutput returns valid deliverables', async () => {
    // Given
    const execRow = makeExec({ state: 'enqueued', jobId: null })
    mockPrisma.card.findUnique.mockResolvedValue(makeCard())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(execRow)
    mockPrisma.cardExecution.update.mockResolvedValue({ ...execRow, jobId: 'job-m3-xyz', project: 'spoonworks' })

    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValue({
      deliverables: ['/deliverables/model.xlsx', '/deliverables/summary.md'],
      summary: 'Built a 3-channel forecast model with companion summary.',
      finalCommit: 'abc123',
      reviewUnconverged: false,
    })
    vi.mocked(deliverablesMod.resolveProjectPath).mockResolvedValue('/tmp/fake-project')
    vi.mocked(deliverablesMod.attachDeliverableArtifact)
      .mockResolvedValueOnce({ artifactId: 'art-1', filename: 'model.xlsx' })
      .mockResolvedValueOnce({ artifactId: 'art-2', filename: 'summary.md' })
    vi.mocked(deliverablesMod.assertSafeDeliverablePath).mockReturnValue(undefined)

    __setMcpClientForTests(makeMcp())

    // When
    await fireExecutionForCard('card-m3abc1234')
    await vi.runAllTimersAsync()
    await flushForTests()

    // Then: the M2 fallback phrase must not appear in any comment
    const m2FallbackComment = commentCalls().find((c) => c.content.includes('Claude Code finished.'))
    expect(m2FallbackComment).toBeUndefined()

    // And the single summary comment is the only delivery comment
    const deliveryComments = commentCalls().filter((c) => c.content.includes('**Claude Code delivered:**'))
    expect(deliveryComments).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC11 — no schema migration regression: CardExecution model accessible at compile time
// ─────────────────────────────────────────────────────────────────────────────

describe('AC11 — Prisma schema sentinel: no migration required for M3', () => {
  it('CardExecution model is accessible from @prisma/client (compile-time check)', async () => {
    // If this import succeeds and the type is accessible, the schema is intact.
    // No schema migration is needed for M3 — the existing artifacts table from M1 suffices.
    const { PrismaClient } = await import('@prisma/client')
    const client = new PrismaClient()
    // The cardExecution field existing on the client type is the assertion.
    expect(typeof client.cardExecution).toBe('object')
    await client.$disconnect()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC7 e2e — [REVIEW UNCONVERGED] prefix carried verbatim into the posted comment
// Spec §E5: when 3 review rounds all return REVISE, Claude commits anyway and
// prepends "[REVIEW UNCONVERGED] " to the SUMMARY. The worker must post that
// prefix — verbatim, not stripped — in the delivery comment.
// ─────────────────────────────────────────────────────────────────────────────

describe('AC7 e2e — [REVIEW UNCONVERGED] prefix is carried verbatim into the posted comment', () => {
  beforeEach(() => {
    // Reset per-test to isolate from the top-level beforeEach state
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetQueueForTests()
    __setMcpClientForTests(null)
    mockPrisma.comment.create.mockResolvedValue({ id: 'comment-unconverged-1' })
    mockPrisma.card.update.mockResolvedValue({})
    mockPrisma.cardExecution.update.mockResolvedValue({ project: 'spoonworks' })
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma)
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    __setMcpClientForTests(null)
    resetQueueForTests()
  })

  it('when parseDeliverableOutput returns reviewUnconverged=true with prefix in summary, the posted comment contains the literal [REVIEW UNCONVERGED] string', async () => {
    // Given — card in In Progress, assigned to agent-claude-code
    const execRow = makeExec({ state: 'enqueued', jobId: null })
    mockPrisma.card.findUnique.mockResolvedValue(makeCard())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(execRow)
    mockPrisma.cardExecution.update.mockResolvedValue({
      ...execRow,
      jobId: 'job-m3-xyz',
      project: 'spoonworks',
      state: 'done',
      output: '(raw output)',
      finishedAt: new Date(),
    })

    // Given — parse returns an UNCONVERGED result with prefix intact in the summary
    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValue({
      deliverables: ['/deliverables/x.md'],
      summary: '[REVIEW UNCONVERGED] still missing cost section',
      finalCommit: 'abc',
      reviewUnconverged: true,
    })

    // Given — project path resolves and artifact attach succeeds
    vi.mocked(deliverablesMod.resolveProjectPath).mockResolvedValue('/projects/spoonworks')
    vi.mocked(deliverablesMod.attachDeliverableArtifact).mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'x.md',
    })
    vi.mocked(deliverablesMod.assertSafeDeliverablePath).mockReturnValue(undefined)

    // Given — MCP returns done immediately on first poll
    __setMcpClientForTests(makeMcp({
      pollClaudeJobStatus: vi.fn().mockResolvedValue({
        state: 'done',
        output: '(raw output)',
        exitCode: 0,
      }),
    }))

    // When — fire execution and drain the queue
    await fireExecutionForCard('card-m3abc1234')
    await vi.runAllTimersAsync()
    await flushForTests()

    // Then — a comment was posted containing the literal [REVIEW UNCONVERGED] prefix
    const allCommentContents = (
      mockPrisma.comment.create.mock.calls as Array<[{ data: { userId: string; content: string } }]>
    ).map(([a]) => a.data)

    const summaryComment = allCommentContents.find(
      (c) => c.content.includes('[REVIEW UNCONVERGED]')
    )

    // The prefix must appear in the delivery comment — not stripped, not transformed
    expect(summaryComment).toBeDefined()
    expect(summaryComment!.userId).toBe('agent-claude-code')
    expect(summaryComment!.content).toContain('[REVIEW UNCONVERGED] still missing cost section')

    // And the standard delivery header must also be present (this is the M3 summary comment)
    expect(summaryComment!.content).toContain('**Claude Code delivered:**')
  })
})
