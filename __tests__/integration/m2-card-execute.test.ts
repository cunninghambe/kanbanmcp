/**
 * M2 Integration Tests — end-to-end card execution pipeline.
 * AC1: PATCH→debounce→worker→MCP→done→Review column + comment
 * AC7: restart resilience (debounce recovery via bootstrapWorker sweep)
 * AC8: restart resilience (in-flight job polling resumes on boot)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Transitive mock requirements ────────────────────────────────────────────
const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
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
  PDFParse: vi.fn(() => ({ getText: vi.fn().mockResolvedValue({ text: '' }), destroy: vi.fn().mockResolvedValue(undefined) })),
}))

// ─── Prisma mock ──────────────────────────────────────────────────────────────
vi.mock('../../src/lib/db', () => {
  const p = {
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
  return { prisma: p, default: p }
})

import { prisma } from '../../src/lib/db'
import {
  fireExecutionForCard,
  bootstrapWorker,
  flushForTests,
  resetQueueForTests,
  __setMcpClientForTests,
} from '../../src/lib/card-execution/worker'
import { resetTimersForTests, __setFireForTests } from '../../src/lib/card-execution/triggers'

type McpClientArg = Parameters<typeof __setMcpClientForTests>[0]

type MockFn = ReturnType<typeof vi.fn>
const mockPrisma = prisma as unknown as {
  board: { findUnique: MockFn }
  card: { findUnique: MockFn; findFirst: MockFn; findMany: MockFn; create: MockFn; update: MockFn }
  column: { findUnique: MockFn }
  orgMember: { findUnique: MockFn; findMany: MockFn }
  cardExecution: { create: MockFn; findFirst: MockFn; findMany: MockFn; update: MockFn }
  comment: { create: MockFn }
  user: { findUnique: MockFn }
  $transaction: MockFn
  apiKey: { findUnique: MockFn; update: MockFn }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const COLS = {
  backlog:    { id: 'col-backlog',     name: 'Backlog',     position: 0 },
  inProgress: { id: 'col-in-progress', name: 'In Progress', position: 1 },
  review:     { id: 'col-review',      name: 'Review',      position: 2 },
  done:       { id: 'col-done',        name: 'Done',        position: 3 },
  blocked:    { id: 'col-blocked',     name: 'Blocked',     position: 4 },
}
const ALL_COLS = Object.values(COLS)
const BOARD = { id: 'board-spoonworks', name: 'Spoonworks', orgId: 'org-1', columns: ALL_COLS }

function makeCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-abc12345', title: 'Build the thing', description: 'A clear spec',
    boardId: BOARD.id, columnId: COLS.backlog.id, assigneeId: 'agent-claude-code',
    board: BOARD, column: COLS.backlog,
    ...overrides,
  }
}

function makeExec(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-1', cardId: 'card-abc12345', jobId: 'job-xyz', state: 'running',
    project: 'spoonworks', branch: 'agent/card-bc12345', spec: 'Build the thing\n\nA clear spec',
    enqueuedAt: new Date(), startedAt: new Date(), finishedAt: null, output: null, errorMessage: null,
    ...overrides,
  }
}

type McpClient = NonNullable<McpClientArg>

function makeMcp(overrides: { submit?: MockFn; poll?: MockFn; list?: MockFn } = {}): McpClient {
  return {
    submitClaudeBuild: (overrides.submit ?? vi.fn().mockResolvedValue({ jobId: 'job-xyz', state: 'enqueued' })) as McpClient['submitClaudeBuild'],
    pollClaudeJobStatus: (overrides.poll ?? vi.fn().mockResolvedValue({ state: 'done', output: 'Build succeeded. Branch: agent/card-bc12345', exitCode: 0 })) as McpClient['pollClaudeJobStatus'],
    listClaudeProjects: (overrides.list ?? vi.fn().mockResolvedValue(['spoonworks'])) as McpClient['listClaudeProjects'],
  }
}

function makeReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

function cardWithBoard(overrides: Record<string, unknown> = {}) {
  return { ...makeCard(overrides), board: { ...BOARD, columns: [...ALL_COLS] } }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: Full happy path via PATCH route
// ─────────────────────────────────────────────────────────────────────────────

describe('AC1: PATCH to In Progress → debounce → worker → done → card in Review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetQueueForTests()
    resetTimersForTests()
    __setMcpClientForTests(null)
    mockSession.userId = 'user-1'
    mockSession.orgId = 'org-1'
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma)
    )
    mockPrisma.comment.create.mockResolvedValue({ id: 'comment-1' })
  })

  afterEach(() => {
    vi.useRealTimers()
    __setMcpClientForTests(null)
    resetTimersForTests()
  })

  it('AC1: PATCH triggers 60s debounce; fire callback invoked with the moved card id', async () => {
    // Given: card in Backlog assigned to agent-claude-code with description
    // We intercept via __setFireForTests to isolate PATCH→trigger from worker internals
    const firedIds: string[] = []
    __setFireForTests(async (id: string) => { firedIds.push(id) })

    const card = makeCard()
    const cardAfterPatch = makeCard({ columnId: COLS.inProgress.id, column: COLS.inProgress })
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockPrisma.card.findFirst.mockResolvedValue(null)
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ ...card, board: { orgId: 'org-1' }, column: { name: 'Backlog' } }) // resolveCard
      .mockResolvedValueOnce(cardAfterPatch) // post-tx re-fetch
      .mockResolvedValueOnce({ description: card.description }) // debounce description check
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)

    // When: PATCH to In Progress
    const { PATCH } = await import('../../src/app/api/cards/[cardId]/route')
    const res = await PATCH(
      makeReq('http://localhost/api/cards/card-abc12345', 'PATCH', { columnId: COLS.inProgress.id }),
      { params: Promise.resolve({ cardId: 'card-abc12345' }) }
    )
    expect(res.status).toBe(200)

    // When: 60s debounce elapses
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()

    // Then: fire was invoked for the card
    expect(firedIds).toContain('card-abc12345')
  })

  it('AC1: when polling returns done, card moves to Review and a completion comment is posted', async () => {
    // Given: card in In Progress — call fireExecutionForCard directly (worker internals)
    const execRow = makeExec({ state: 'enqueued', jobId: null })
    mockPrisma.card.findUnique.mockResolvedValue(cardWithBoard({ columnId: COLS.inProgress.id, column: COLS.inProgress }))
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(execRow)
    mockPrisma.cardExecution.update.mockResolvedValue({ ...execRow, jobId: 'job-xyz' })
    mockPrisma.card.update.mockResolvedValue({ ...makeCard(), columnId: COLS.review.id })

    __setMcpClientForTests(makeMcp({
      poll: vi.fn().mockResolvedValue({ state: 'done', output: 'Build succeeded on branch agent/card-bc12345', exitCode: 0 }),
    }))

    // When
    await fireExecutionForCard('card-abc12345')
    await vi.runAllTimersAsync()
    await flushForTests()

    // Then: card moved to Review
    const moveToReview = (mockPrisma.card.update.mock.calls as Array<[{ data: { columnId: string } }]>)
      .find((c) => c[0].data.columnId === COLS.review.id)
    expect(moveToReview).toBeDefined()

    // Then: done comment from agent-claude-code with output text
    const doneComment = (mockPrisma.comment.create.mock.calls as Array<[{ data: { userId: string; content: string } }]>)
      .find((c) => c[0].data.content.includes('Claude Code finished'))
    expect(doneComment).toBeDefined()
    expect(doneComment![0].data.userId).toBe('agent-claude-code')
    expect(doneComment![0].data.content).toContain('agent/card-bc12345')

    // Then: CardExecution updated to done
    const doneExec = (mockPrisma.cardExecution.update.mock.calls as Array<[{ data: { state: string } }]>)
      .find((c) => c[0].data.state === 'done')
    expect(doneExec).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC7: Restart resilience — debounce recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('AC7: bootstrapWorker sweeps eligible In Progress cards and fires execution immediately', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetQueueForTests()
    resetTimersForTests()
    __setMcpClientForTests(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    __setMcpClientForTests(null)
    resetTimersForTests()
  })

  it('AC7: card in In Progress for 90s with no execution → CardExecution created after boot', async () => {
    // Given: card updated 90s ago, in In Progress, no active execution
    const card = makeCard({ columnId: COLS.inProgress.id, column: COLS.inProgress, updatedAt: new Date(Date.now() - 90_000) })
    mockPrisma.cardExecution.findMany.mockResolvedValueOnce([]) // no in-flight jobs
    mockPrisma.card.findMany.mockResolvedValueOnce([card])     // sweep candidate

    const execRow = makeExec({ state: 'enqueued', jobId: null })
    mockPrisma.card.findUnique.mockResolvedValue(cardWithBoard({ columnId: COLS.inProgress.id, column: COLS.inProgress }))
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(execRow)
    mockPrisma.cardExecution.update.mockResolvedValue({ ...execRow, jobId: 'job-xyz' })

    __setMcpClientForTests(makeMcp())

    // When: process restarts and bootstrapWorker runs
    await bootstrapWorker()
    await vi.advanceTimersByTimeAsync(0)
    await flushForTests()

    // Then: CardExecution created for the eligible card
    expect(mockPrisma.cardExecution.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cardId: 'card-abc12345', state: 'enqueued' }) })
    )
  })

  it('AC7: card with an active execution is NOT re-enqueued by sweep', async () => {
    // Given: sweep returns no eligible candidates (already filtered by Prisma query)
    mockPrisma.cardExecution.findMany.mockResolvedValueOnce([])
    mockPrisma.card.findMany.mockResolvedValueOnce([])
    const mcp = makeMcp()
    __setMcpClientForTests(mcp)

    await bootstrapWorker()
    await vi.advanceTimersByTimeAsync(0)
    await flushForTests()

    // Then: no execution created, no MCP call
    expect(mockPrisma.cardExecution.create).not.toHaveBeenCalled()
    expect(mcp.submitClaudeBuild).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC8: Restart resilience — in-flight job recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('AC8: bootstrapWorker reattaches polling for in-flight jobs and drives them to terminal state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetQueueForTests()
    resetTimersForTests()
    __setMcpClientForTests(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    __setMcpClientForTests(null)
    resetTimersForTests()
  })

  it('AC8: running job on boot → polling resumes → done → card moved to Review, comment posted', async () => {
    // Given: CardExecution state=running with valid jobId
    const exec = makeExec({ state: 'running', jobId: 'job-xyz' })
    const card = makeCard({ columnId: COLS.inProgress.id, column: COLS.inProgress })

    mockPrisma.cardExecution.findMany.mockResolvedValueOnce([exec])
    mockPrisma.card.findMany.mockResolvedValueOnce([])
    mockPrisma.card.findUnique.mockResolvedValue(cardWithBoard({ columnId: COLS.inProgress.id, column: COLS.inProgress }))
    mockPrisma.cardExecution.findFirst.mockResolvedValue({ state: 'running' })
    mockPrisma.cardExecution.update.mockResolvedValue({ ...exec, state: 'done', finishedAt: new Date() })
    mockPrisma.card.update.mockResolvedValue({ ...card, columnId: COLS.review.id })

    const pollDone = vi.fn().mockResolvedValue({ state: 'done', output: 'Commit abc123 on branch agent/card-bc12345', exitCode: 0 })
    __setMcpClientForTests(makeMcp({ poll: pollDone }))

    // When: server restarts; bootstrapWorker runs
    await bootstrapWorker()
    await vi.advanceTimersByTimeAsync(0)
    await flushForTests()

    // Then: poll was called with stored jobId
    expect(pollDone).toHaveBeenCalledWith('job-xyz')

    // Then: CardExecution → done
    const doneExec = (mockPrisma.cardExecution.update.mock.calls as Array<[{ data: { state: string } }]>)
      .find((c) => c[0].data.state === 'done')
    expect(doneExec).toBeDefined()

    // Then: card moved to Review
    const toReview = (mockPrisma.card.update.mock.calls as Array<[{ data: { columnId: string } }]>)
      .find((c) => c[0].data.columnId === COLS.review.id)
    expect(toReview).toBeDefined()

    // Then: completion comment posted
    const doneCmt = (mockPrisma.comment.create.mock.calls as Array<[{ data: { userId: string; content: string } }]>)
      .find((c) => c[0].data.content.includes('Claude Code finished'))
    expect(doneCmt).toBeDefined()
  })

  it('AC8: running job that fails on boot → card moved to Blocked, failure comment posted', async () => {
    // Given: CardExecution state=running, job returns failed
    const exec = makeExec({ state: 'running', jobId: 'job-fail' })
    const card = makeCard({ columnId: COLS.inProgress.id, column: COLS.inProgress })

    mockPrisma.cardExecution.findMany.mockResolvedValueOnce([exec])
    mockPrisma.card.findMany.mockResolvedValueOnce([])
    mockPrisma.card.findUnique.mockResolvedValue(cardWithBoard({ columnId: COLS.inProgress.id, column: COLS.inProgress }))
    mockPrisma.cardExecution.findFirst.mockResolvedValue({ state: 'running' })
    mockPrisma.cardExecution.update.mockResolvedValue({ ...exec, state: 'failed', finishedAt: new Date() })
    mockPrisma.card.update.mockResolvedValue({ ...card, columnId: COLS.blocked.id })

    const pollFailed = vi.fn().mockResolvedValue({ state: 'failed', errorDetail: 'Build failed: tests did not pass', exitCode: 1 })
    __setMcpClientForTests(makeMcp({ poll: pollFailed }))

    await bootstrapWorker()
    await vi.advanceTimersByTimeAsync(0)
    await flushForTests()

    // Then: CardExecution → failed
    const failExec = (mockPrisma.cardExecution.update.mock.calls as Array<[{ data: { state: string } }]>)
      .find((c) => c[0].data.state === 'failed')
    expect(failExec).toBeDefined()

    // Then: card moved to Blocked
    const toBlocked = (mockPrisma.card.update.mock.calls as Array<[{ data: { columnId: string } }]>)
      .find((c) => c[0].data.columnId === COLS.blocked.id)
    expect(toBlocked).toBeDefined()

    // Then: failure comment from agent-claude-code
    const failCmt = (mockPrisma.comment.create.mock.calls as Array<[{ data: { userId: string; content: string } }]>)
      .find((c) => c[0].data.content.includes('Claude Code failed'))
    expect(failCmt).toBeDefined()
    expect(failCmt![0].data.userId).toBe('agent-claude-code')
  })
})
