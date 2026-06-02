/**
 * G5 resilience tests for src/lib/card-execution/worker.ts
 *
 * Covers:
 *  #2 concurrent fire dedup (keyed lock) — exactly one build job per card.
 *  #3 poll deadline + bounded unknown-state handling — force-fail + Blocked.
 *  #4 transient poll error reschedules with backoff (not orphaned), and
 *     exhausting retries force-fails + moves to Blocked.
 *
 * Mirrors the mocking pattern in card-execution-worker.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  card: { findUnique: vi.fn(), update: vi.fn() },
  cardExecution: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  comment: { create: vi.fn() },
}

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

vi.mock('../../prisma/seed-claude-code-agent', () => ({
  CLAUDE_CODE_AGENT_EMAIL: 'claude-code@agents.internal',
  CLAUDE_CODE_AGENT_ID: 'agent-claude-code',
  ensureClaudeCodeAgentUser: vi.fn().mockResolvedValue({ id: 'agent-claude-code' }),
}))

vi.mock('../../src/lib/card-execution/deliverables', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/card-execution/deliverables')>()
  return {
    ...mod,
    parseDeliverableOutput: vi.fn().mockReturnValue({ deliverables: [], summary: null, finalCommit: null, reviewUnconverged: false }),
    resolveProjectPath: vi.fn().mockResolvedValue(null),
    attachDeliverableArtifact: vi.fn().mockResolvedValue({ skipped: 'missing' }),
    assertSafeDeliverablePath: vi.fn(),
  }
})

import {
  fireExecutionForCard,
  flushForTests,
  resetQueueForTests,
  __setMcpClientForTests,
} from '../../src/lib/card-execution/worker'

// ─── Types & fixtures ─────────────────────────────────────────────────────────

type PollResult = { state: string; output?: string; errorDetail?: string; exitCode?: number }

type McpClient = {
  submitClaudeBuild: (a: { project: string; spec: string; branch: string }) => Promise<{ jobId: string; state: string }>
  pollClaudeJobStatus: (jobId: string) => Promise<PollResult>
  listClaudeProjects: () => Promise<string[]>
}

const NOW = new Date('2026-05-20T12:00:00.000Z')
const STALE_AT = new Date(NOW.getTime() - 90_000)

const FULL_BOARD = {
  id: 'board-1',
  name: 'Spoonworks',
  columns: [
    { id: 'col-backlog', name: 'Backlog' },
    { id: 'col-ip', name: 'In Progress' },
    { id: 'col-review', name: 'Review' },
    { id: 'col-done', name: 'Done' },
    { id: 'col-blocked', name: 'Blocked' },
  ],
}

function card(ov: Record<string, unknown> = {}) {
  return {
    id: 'card-abc12345',
    title: 'Build login',
    description: 'Implement OAuth2',
    assigneeId: 'agent-claude-code',
    columnId: 'col-ip',
    boardId: 'board-1',
    updatedAt: STALE_AT,
    board: FULL_BOARD,
    column: { id: 'col-ip', name: 'In Progress' },
    ...ov,
  }
}

function exec(ov: Record<string, unknown> = {}) {
  return {
    id: 'exec-001',
    cardId: 'card-abc12345',
    jobId: null,
    state: 'enqueued',
    project: 'spoonworks',
    branch: 'agent/card-bc12345',
    spec: 'Build login\n\nImplement OAuth2',
    output: null,
    errorMessage: null,
    enqueuedAt: NOW,
    startedAt: null,
    finishedAt: null,
    ...ov,
  }
}

function client(ov: Partial<McpClient> = {}): McpClient {
  return {
    submitClaudeBuild: vi.fn().mockResolvedValue({ jobId: 'job-abc', state: 'enqueued' }),
    pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'ok' }),
    listClaudeProjects: vi.fn().mockResolvedValue(['spoonworks']),
    ...ov,
  }
}

function updateStates(): string[] {
  return (mockPrisma.cardExecution.update.mock.calls as Array<[{ data: { state?: string } }]>)
    .map(([a]) => a.data.state)
    .filter((s): s is string => Boolean(s))
}

function movedToColumn(columnId: string): boolean {
  return (mockPrisma.card.update.mock.calls as Array<[{ data: { columnId?: string } }]>).some(
    ([a]) => a.data.columnId === columnId
  )
}

function postedComment(substr: string): boolean {
  return (mockPrisma.comment.create.mock.calls as Array<[{ data: { content: string } }]>).some(
    ([a]) => a.data.content.includes(substr)
  )
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  resetQueueForTests()
  __setMcpClientForTests(null)
  delete process.env.CARD_EXEC_MAX_MS
  mockPrisma.comment.create.mockResolvedValue({ id: 'c1' })
  mockPrisma.card.update.mockResolvedValue({})
  mockPrisma.cardExecution.update.mockResolvedValue({ project: 'spoonworks' })
})

afterEach(() => {
  __setMcpClientForTests(null)
  resetQueueForTests()
  vi.useRealTimers()
  delete process.env.CARD_EXEC_MAX_MS
})

// ─── #4: transient poll error reschedules (not orphaned) ───────────────────────

describe('poll tick — transient error reschedules and eventually completes (#4)', () => {
  it('a single poll throw reschedules a tick that then reaches done (not orphaned)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))

    let tick = 0
    const poll = vi.fn().mockImplementation(async () => {
      tick += 1
      if (tick === 1) throw new Error('ECONNRESET to ClaudeMCP')
      return { state: 'done', exitCode: 0, output: 'commit done' }
    })
    __setMcpClientForTests(client({ pollClaudeJobStatus: poll }))

    vi.useFakeTimers()
    const p = fireExecutionForCard('card-abc12345')
    await vi.runAllTimersAsync()
    await p
    await flushForTests()
    vi.useRealTimers()

    // Polled at least twice (first threw, retry succeeded).
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(2)
    // Eventually reached done — execution not stuck.
    expect(updateStates()).toContain('done')
    expect(movedToColumn('col-review')).toBe(true)
  })

  it('exhausting transient retries force-fails the execution and moves card to Blocked', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))

    // Always throw → retries exhaust (MAX_POLL_RETRIES = 5, so 6th attempt fails).
    const poll = vi.fn().mockRejectedValue(new Error('ClaudeMCP down'))
    __setMcpClientForTests(client({ pollClaudeJobStatus: poll }))

    vi.useFakeTimers()
    const p = fireExecutionForCard('card-abc12345')
    await vi.runAllTimersAsync()
    await p
    await flushForTests()
    vi.useRealTimers()

    expect(updateStates()).toContain('failed')
    expect(movedToColumn('col-blocked')).toBe(true)
    // Stopped retrying after a bounded number of attempts.
    expect(poll.mock.calls.length).toBeLessThanOrEqual(6 + 1)
    expect(postedComment('ClaudeMCP down')).toBe(true)
  })
})

// ─── #3: deadline + unknown-state handling ─────────────────────────────────────

describe('poll tick — deadline & unknown states (#3)', () => {
  it('exceeding the execution deadline marks failed + moves card to Blocked', async () => {
    // Tiny deadline so the first running poll already trips it on the next tick.
    process.env.CARD_EXEC_MAX_MS = '1'
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))

    // Always "running" — without a deadline this would poll forever.
    const poll = vi.fn().mockResolvedValue({ state: 'running' })
    __setMcpClientForTests(client({ pollClaudeJobStatus: poll }))

    vi.useFakeTimers()
    const p = fireExecutionForCard('card-abc12345')
    // Advance well past the 1ms deadline so a later tick force-fails it.
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    await flushForTests()
    vi.useRealTimers()

    expect(updateStates()).toContain('failed')
    expect(movedToColumn('col-blocked')).toBe(true)
    expect(postedComment('timed out')).toBe(true)
  })

  it('persistently-unknown states are classified as failure after a bounded count', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))

    // A state the worker does not recognise (not running, not terminal).
    const poll = vi.fn().mockResolvedValue({ state: 'limbo' })
    __setMcpClientForTests(client({ pollClaudeJobStatus: poll }))

    vi.useFakeTimers()
    const p = fireExecutionForCard('card-abc12345')
    await vi.advanceTimersByTimeAsync(60_000)
    await p
    await flushForTests()
    vi.useRealTimers()

    expect(updateStates()).toContain('failed')
    expect(movedToColumn('col-blocked')).toBe(true)
    expect(postedComment('unknown state')).toBe(true)
    // Did not poll forever.
    expect(poll.mock.calls.length).toBeLessThanOrEqual(10)
  })
})

// ─── #2: concurrent fire dedup ─────────────────────────────────────────────────

describe('fireExecutionForCard — concurrent dedup (#2)', () => {
  it('POSITIVE: two concurrent fires for the same card create exactly ONE execution + one build', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())

    // Model the active-execution check against an in-memory store so the second
    // fire observes the first fire's created row. findFirst awaits a microtask
    // to widen the race window — only the keyed lock prevents a double create.
    const rows: Array<{ id: string; cardId: string; state: string }> = []
    mockPrisma.cardExecution.findFirst.mockImplementation(async (args: {
      where: { cardId: string; state: { in: string[] } }
    }) => {
      await Promise.resolve()
      return (
        rows.find((r) => r.cardId === args.where.cardId && args.where.state.in.includes(r.state)) ??
        null
      )
    })
    mockPrisma.cardExecution.create.mockImplementation(async (args: { data: { cardId: string; state: string } }) => {
      const row = { id: `exec-${rows.length + 1}`, cardId: args.data.cardId, state: args.data.state }
      rows.push(row)
      return { ...exec({ id: row.id, state: row.state }) }
    })

    const c = client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'ok' }) })
    __setMcpClientForTests(c)

    await Promise.all([
      fireExecutionForCard('card-abc12345'),
      fireExecutionForCard('card-abc12345'),
    ])
    await flushForTests()

    const enqueuedCreates = (mockPrisma.cardExecution.create.mock.calls as Array<[{ data: { state: string } }]>).filter(
      ([a]) => a.data.state === 'enqueued'
    )
    expect(enqueuedCreates).toHaveLength(1)
    expect(c.submitClaudeBuild).toHaveBeenCalledTimes(1)
  })

  it('NEGATIVE: concurrent fires for DIFFERENT cards both create + both submit', async () => {
    mockPrisma.card.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
      card({ id: args.where.id })
    )
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockImplementation(async (args: { data: { cardId: string } }) =>
      exec({ id: `exec-${args.data.cardId}`, jobId: 'job-' + args.data.cardId })
    )

    let jobSeq = 0
    const c = client({
      submitClaudeBuild: vi.fn().mockImplementation(async () => ({ jobId: `job-${jobSeq++}`, state: 'enqueued' })),
      pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'ok' }),
    })
    __setMcpClientForTests(c)

    await Promise.all([
      fireExecutionForCard('card-aaa11111'),
      fireExecutionForCard('card-bbb22222'),
    ])
    await flushForTests()

    const enqueuedCreates = (mockPrisma.cardExecution.create.mock.calls as Array<[{ data: { state: string } }]>).filter(
      ([a]) => a.data.state === 'enqueued'
    )
    expect(enqueuedCreates).toHaveLength(2)
    expect(c.submitClaudeBuild).toHaveBeenCalledTimes(2)
  })
})
