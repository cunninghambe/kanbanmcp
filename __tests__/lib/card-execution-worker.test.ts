/**
 * Unit tests for src/lib/card-execution/worker.ts (Task 11 — TDD)
 *
 * The module under test does NOT exist yet. These tests fail to import
 * until Task 12 lands. That is the correct TDD state.
 *
 * Spec coverage: AC1, AC4, AC5, AC6, AC7, AC8 / E3, E6, E7, E8, E11, E12
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

import * as deliverablesMod from '../../src/lib/card-execution/deliverables'

import {
  fireExecutionForCard,
  bootstrapWorker,
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
  mockPrisma.comment.create.mockResolvedValue({ id: 'c1' })
  mockPrisma.card.update.mockResolvedValue({})
  mockPrisma.cardExecution.update.mockResolvedValue({})
})

afterEach(() => {
  __setMcpClientForTests(null)
  resetQueueForTests()
})

// ─── AC1, AC4: happy path ─────────────────────────────────────────────────────

describe('fireExecutionForCard — happy path (AC1, AC4)', () => {
  it('creates CardExecution row state=enqueued, correct spec and branch suffix', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec())
    __setMcpClientForTests(client())
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.cardExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ cardId: 'card-abc12345', state: 'enqueued', project: 'spoonworks', branch: 'agent/card-bc12345', spec: expect.stringContaining('Build login') }),
    })
  })

  it('calls submitClaudeBuild with project, spec, branch', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec())
    const c = client()
    __setMcpClientForTests(c)
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(c.submitClaudeBuild).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'spoonworks', spec: expect.stringContaining('Build login'), branch: 'agent/card-bc12345', runTests: false })
    )
  })

  it('posts started-working comment with project, branch, jobId', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec())
    __setMcpClientForTests(client())
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    const calls = mockPrisma.comment.create.mock.calls as Array<[{ data: { content: string; cardId: string } }]>
    const found = calls.find(([a]) => a.data.cardId === 'card-abc12345' && a.data.content.includes('Claude Code started') && a.data.content.includes('spoonworks') && a.data.content.includes('agent/card-bc12345') && a.data.content.includes('job-abc'))
    expect(found).toBeDefined()
  })

  it('updates row running→done and moves card to Review (AC4)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    let tick = 0
    __setMcpClientForTests(client({ pollClaudeJobStatus: vi.fn().mockImplementation(async () => tick++ === 0 ? { state: 'running' } : { state: 'done', exitCode: 0, output: 'ok' }) }))
    vi.useFakeTimers()
    const p = fireExecutionForCard('card-abc12345')
    vi.runAllTimersAsync()
    await p
    await flushForTests()
    vi.useRealTimers()
    const states = (mockPrisma.cardExecution.update.mock.calls as Array<[{ data: { state: string } }]>).map(([a]) => a.data.state)
    expect(states).toContain('running')
    expect(states).toContain('done')
    expect(mockPrisma.card.update).toHaveBeenCalledWith({ where: { id: 'card-abc12345' }, data: { columnId: 'col-review' } })
  })

  it('posts done comment containing build output (AC4)', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    __setMcpClientForTests(client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'commit abc123' }) }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(postedComment('commit abc123')).toBe(true)
  })
})

// ─── AC5: failed job ──────────────────────────────────────────────────────────

describe('fireExecutionForCard — failed terminal state (AC5)', () => {
  it('sets row failed, moves to Blocked, posts error comment when poll=failed', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    __setMcpClientForTests(client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'failed', errorDetail: 'Build timed out' }) }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.cardExecution.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }))
    expect(mockPrisma.card.update).toHaveBeenCalledWith({ where: { id: 'card-abc12345' }, data: { columnId: 'col-blocked' } })
    expect(postedComment('Build timed out')).toBe(true)
  })
})

// ─── E12: done exitCode != 0 treated as failed ────────────────────────────────

describe('fireExecutionForCard — done exitCode != 0 = failed (E12)', () => {
  it('sets row failed (not done), moves to Blocked, posts output in comment', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    __setMcpClientForTests(client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 1, output: 'Tests failed: 3' }) }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    const states = (mockPrisma.cardExecution.update.mock.calls as Array<[{ data: { state: string } }]>).map(([a]) => a.data.state)
    expect(states).toContain('failed')
    expect(states).not.toContain('done')
    expect(mockPrisma.card.update).toHaveBeenCalledWith({ where: { id: 'card-abc12345' }, data: { columnId: 'col-blocked' } })
    expect(postedComment('Tests failed: 3')).toBe(true)
  })
})

// ─── AC6, E3: unmapped project ────────────────────────────────────────────────

describe('fireExecutionForCard — unmapped project (AC6, E3)', () => {
  beforeEach(() => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ state: 'failed' }))
  })

  it('does not call submitClaudeBuild', async () => {
    const c = client({ listClaudeProjects: vi.fn().mockResolvedValue(['dash']), submitClaudeBuild: vi.fn() })
    __setMcpClientForTests(c)
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(c.submitClaudeBuild).not.toHaveBeenCalled()
  })

  it('creates row state=failed with error referencing projects.json and SIGHUP (E3)', async () => {
    __setMcpClientForTests(client({ listClaudeProjects: vi.fn().mockResolvedValue(['dash']) }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()

    expect(mockPrisma.cardExecution.create).toHaveBeenCalledWith({ data: expect.objectContaining({ state: 'failed' }) })
    const errMsg = (mockPrisma.cardExecution.create.mock.calls[0][0] as { data: { errorMessage: string } }).data.errorMessage
    expect(errMsg).toMatch(/projects\.json/i)
    expect(errMsg).toMatch(/SIGHUP/i)
  })

  it('moves card to Blocked and posts a comment (AC6)', async () => {
    __setMcpClientForTests(client({ listClaudeProjects: vi.fn().mockResolvedValue(['dash']) }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()

    expect(mockPrisma.card.update).toHaveBeenCalledWith({ where: { id: 'card-abc12345' }, data: { columnId: 'col-blocked' } })
    expect(mockPrisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cardId: 'card-abc12345' }) })
    )
  })
})

// ─── E6: submit throws ────────────────────────────────────────────────────────

describe('fireExecutionForCard — submitClaudeBuild throws (E6)', () => {
  it('sets row failed, moves to Blocked, posts error comment, never polls', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec())
    const c = client({ submitClaudeBuild: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), pollClaudeJobStatus: vi.fn() })
    __setMcpClientForTests(c)
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.cardExecution.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }))
    expect(mockPrisma.card.update).toHaveBeenCalledWith({ where: { id: 'card-abc12345' }, data: { columnId: 'col-blocked' } })
    expect(c.pollClaudeJobStatus).not.toHaveBeenCalled()
    expect(postedComment('ECONNREFUSED')).toBe(true)
  })
})

// ─── Invariants abort ─────────────────────────────────────────────────────────

describe('fireExecutionForCard — invariants changed, abort silently', () => {
  it('aborts when assignee is no longer Claude Code', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card({ assigneeId: 'user-human' }))
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    const c = client()
    __setMcpClientForTests(c)
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.cardExecution.create).not.toHaveBeenCalled()
    expect(mockPrisma.comment.create).not.toHaveBeenCalled()
    expect(c.submitClaudeBuild).not.toHaveBeenCalled()
  })

  it('aborts when column is no longer In Progress', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card({ column: { id: 'col-backlog', name: 'Backlog' } }))
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    __setMcpClientForTests(client())
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.cardExecution.create).not.toHaveBeenCalled()
    expect(mockPrisma.comment.create).not.toHaveBeenCalled()
  })

  it('aborts when description is empty', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card({ description: '' }))
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    __setMcpClientForTests(client())
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.cardExecution.create).not.toHaveBeenCalled()
    expect(mockPrisma.comment.create).not.toHaveBeenCalled()
  })

  it('aborts when an active CardExecution already exists', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(exec({ state: 'running', jobId: 'job-x' }))
    const c = client()
    __setMcpClientForTests(c)
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.cardExecution.create).not.toHaveBeenCalled()
    expect(c.submitClaudeBuild).not.toHaveBeenCalled()
  })

  it('resolves without throwing when card does not exist', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    __setMcpClientForTests(client())
    await expect(fireExecutionForCard('card-abc12345')).resolves.toBeUndefined()
    expect(mockPrisma.cardExecution.create).not.toHaveBeenCalled()
  })
})

// ─── AC8, E8: bootstrap polling reattach ──────────────────────────────────────

describe('bootstrapWorker — polling reattach (AC8, E8)', () => {
  beforeEach(() => {
    ;(mockPrisma.card as Record<string, unknown>).findMany = vi.fn().mockResolvedValue([])
  })

  it('resumes polling for state=running execution and updates row to done', async () => {
    mockPrisma.cardExecution.findMany.mockResolvedValueOnce([exec({ state: 'running', jobId: 'job-xyz' })])
    mockPrisma.card.findUnique.mockResolvedValue(card())
    const c = client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'ok' }) })
    __setMcpClientForTests(c)
    await bootstrapWorker()
    await flushForTests()
    expect(c.pollClaudeJobStatus).toHaveBeenCalledWith('job-xyz')
    expect(mockPrisma.cardExecution.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'done' }) }))
  })

  it('resumes polling for state=enqueued execution (jobId already assigned pre-restart)', async () => {
    mockPrisma.cardExecution.findMany.mockResolvedValueOnce([exec({ state: 'enqueued', jobId: 'job-enq' })])
    mockPrisma.card.findUnique.mockResolvedValue(card())
    const c = client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'ok' }) })
    __setMcpClientForTests(c)
    await bootstrapWorker()
    await flushForTests()
    expect(c.pollClaudeJobStatus).toHaveBeenCalledWith('job-enq')
  })
})

// ─── AC7, E7: boot sweep ──────────────────────────────────────────────────────

describe('bootstrapWorker — boot sweep (AC7, E7)', () => {
  it('fires fireExecutionForCard for stale In Progress card (updatedAt >= 60s ago)', async () => {
    mockPrisma.cardExecution.findMany.mockResolvedValueOnce([])
    ;(mockPrisma.card as Record<string, unknown>).findMany = vi.fn().mockResolvedValue([
      { id: 'card-abc12345', assigneeId: 'agent-claude-code', description: 'Implement OAuth2', updatedAt: STALE_AT, column: { name: 'In Progress' } },
    ])
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec())
    __setMcpClientForTests(client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'ok' }) }))
    await bootstrapWorker()
    await flushForTests()
    expect(mockPrisma.card.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'card-abc12345' } }))
  })

  it('does not fire when sweep returns no candidates', async () => {
    mockPrisma.cardExecution.findMany.mockResolvedValueOnce([])
    ;(mockPrisma.card as Record<string, unknown>).findMany = vi.fn().mockResolvedValue([])
    const c = client()
    __setMcpClientForTests(c)
    await bootstrapWorker()
    await flushForTests()
    expect(c.submitClaudeBuild).not.toHaveBeenCalled()
    expect(mockPrisma.cardExecution.create).not.toHaveBeenCalled()
  })
})

// ─── E11: card deleted mid-poll ───────────────────────────────────────────────

describe('fireExecutionForCard — card deleted mid-poll (E11)', () => {
  it('stops polling without throwing and posts no running/done comments after deletion', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce(card()) // initial check
      .mockResolvedValueOnce(null)   // polling tick: card gone
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    __setMcpClientForTests(client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'running' }) }))
    await expect(async () => {
      await fireExecutionForCard('card-abc12345')
      await flushForTests()
    }).not.toThrow()
    const postDeletion = (mockPrisma.comment.create.mock.calls as Array<[{ data: { content: string } }]>).filter(
      ([a]) => a.data.content.toLowerCase().includes('running') || a.data.content.toLowerCase().includes('done')
    )
    expect(postDeletion).toHaveLength(0)
  })
})

// ─── E9: missing target column ────────────────────────────────────────────────

describe('fireExecutionForCard — missing target column (E9)', () => {
  it('posts done comment without moving card when Review column absent', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card({
      board: { id: 'board-1', name: 'Spoonworks', columns: [
        { id: 'col-ip', name: 'In Progress' }, { id: 'col-done', name: 'Done' }, { id: 'col-blocked', name: 'Blocked' },
      ]},
    }))
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    __setMcpClientForTests(client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'ok' }) }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.comment.create).toHaveBeenCalled()
    const moveCalls = (mockPrisma.card.update.mock.calls as Array<[{ data: { columnId?: string } }]>).filter(([a]) => 'columnId' in (a.data ?? {}))
    expect(moveCalls).toHaveLength(0)
  })

  it('posts failed comment without throwing when Blocked column absent', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card({
      board: { id: 'board-1', name: 'Spoonworks', columns: [
        { id: 'col-ip', name: 'In Progress' }, { id: 'col-review', name: 'Review' }, { id: 'col-done', name: 'Done' },
      ]},
    }))
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    __setMcpClientForTests(client({ pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'failed', errorDetail: 'err' }) }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.comment.create).toHaveBeenCalled()
  })
})

// ─── M3: happy path ───────────────────────────────────────────────────────────

describe('M3 — happy path delivery', () => {
  it('posts ONE comment with header + summary + attached filename; moves card to Review; state=done', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    mockPrisma.cardExecution.update.mockResolvedValue({ project: 'spoonworks' })
    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValueOnce({
      deliverables: ['/deliverables/plan.md'],
      summary: 'A great plan was produced.',
      finalCommit: 'abc1234',
      reviewUnconverged: false,
    })
    vi.mocked(deliverablesMod.resolveProjectPath).mockResolvedValueOnce('/projects/spoonworks')
    vi.mocked(deliverablesMod.attachDeliverableArtifact).mockResolvedValueOnce({ artifactId: 'art-1', filename: 'plan.md' })
    __setMcpClientForTests(client({
      pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'DELIVERABLES: /deliverables/plan.md\nSUMMARY: A great plan was produced.\nFINAL COMMIT: abc1234' }),
    }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    const states = (mockPrisma.cardExecution.update.mock.calls as Array<[{ data: { state?: string } }]>).map(([a]) => a.data.state).filter(Boolean)
    expect(states).toContain('done')
    expect(mockPrisma.card.update).toHaveBeenCalledWith({ where: { id: 'card-abc12345' }, data: { columnId: 'col-review' } })
    const commentCalls = mockPrisma.comment.create.mock.calls as Array<[{ data: { content: string } }]>
    const summaryCall = commentCalls.find(([a]) => a.data.content.includes('Claude Code delivered:'))
    expect(summaryCall).toBeDefined()
    expect(summaryCall![0].data.content).toContain('A great plan was produced.')
    expect(summaryCall![0].data.content).toContain('plan.md')
    const deliveryComments = commentCalls.filter(([a]) => a.data.content.includes('Claude Code delivered:'))
    expect(deliveryComments).toHaveLength(1)
  })
})

// ─── M3: missing protocol fallback ───────────────────────────────────────────

describe('M3 — missing DELIVERABLES protocol (fallback)', () => {
  it('posts TWO comments: M2 fallback + M3 warning; card still moved to Review', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    mockPrisma.cardExecution.update.mockResolvedValue({ project: 'spoonworks' })
    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValueOnce({
      deliverables: [],
      summary: null,
      finalCommit: null,
      reviewUnconverged: false,
    })
    __setMcpClientForTests(client({
      pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'Just some output, no protocol.' }),
    }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(mockPrisma.card.update).toHaveBeenCalledWith({ where: { id: 'card-abc12345' }, data: { columnId: 'col-review' } })
    const commentCalls = mockPrisma.comment.create.mock.calls as Array<[{ data: { content: string } }]>
    const fallback = commentCalls.find(([a]) => a.data.content.includes('Claude Code finished.'))
    const warning = commentCalls.find(([a]) => a.data.content.includes('M3 protocol warning'))
    expect(fallback).toBeDefined()
    expect(warning).toBeDefined()
  })
})

// ─── M3: unresolvable project path ───────────────────────────────────────────

describe('M3 — unresolvable project path', () => {
  it('posts ONE comment about unresolved path; no artifact attach attempts', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    mockPrisma.cardExecution.update.mockResolvedValue({ project: 'spoonworks' })
    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValueOnce({
      deliverables: ['/deliverables/plan.md'],
      summary: 'A plan.',
      finalCommit: 'abc1234',
      reviewUnconverged: false,
    })
    vi.mocked(deliverablesMod.resolveProjectPath).mockResolvedValueOnce(null)
    __setMcpClientForTests(client({
      pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'DELIVERABLES: /deliverables/plan.md\nSUMMARY: A plan.\nFINAL COMMIT: abc1234' }),
    }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(deliverablesMod.attachDeliverableArtifact).not.toHaveBeenCalled()
    const commentCalls = mockPrisma.comment.create.mock.calls as Array<[{ data: { content: string } }]>
    const pathComment = commentCalls.find(([a]) => a.data.content.includes('could not be resolved'))
    expect(pathComment).toBeDefined()
  })
})

// ─── M3: path escape rejected ────────────────────────────────────────────────

describe('M3 — path escape rejected (E3, E9)', () => {
  it('rejects unsafe paths, attaches safe path, lists bad ones in skipped footer', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec({ jobId: 'job-abc' }))
    mockPrisma.cardExecution.update.mockResolvedValue({ project: 'spoonworks' })
    vi.mocked(deliverablesMod.parseDeliverableOutput).mockReturnValueOnce({
      deliverables: ['../etc/passwd', '/deliverables/ok.md', '/etc/passwd'],
      summary: 'Done.',
      finalCommit: 'abc1234',
      reviewUnconverged: false,
    })
    vi.mocked(deliverablesMod.resolveProjectPath).mockResolvedValueOnce('/projects/spoonworks')
    vi.mocked(deliverablesMod.assertSafeDeliverablePath).mockImplementation((p: string) => {
      if (p !== '/deliverables/ok.md') throw new Error(`Unsafe deliverable path: ${p}`)
    })
    vi.mocked(deliverablesMod.attachDeliverableArtifact).mockResolvedValueOnce({ artifactId: 'art-1', filename: 'ok.md' })
    __setMcpClientForTests(client({
      pollClaudeJobStatus: vi.fn().mockResolvedValue({ state: 'done', exitCode: 0, output: 'DELIVERABLES: ../etc/passwd, /deliverables/ok.md, /etc/passwd\nSUMMARY: Done.\nFINAL COMMIT: abc1234' }),
    }))
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    expect(deliverablesMod.attachDeliverableArtifact).toHaveBeenCalledTimes(1)
    expect(deliverablesMod.attachDeliverableArtifact).toHaveBeenCalledWith('card-abc12345', '/projects/spoonworks', '/deliverables/ok.md')
    const commentCalls = mockPrisma.comment.create.mock.calls as Array<[{ data: { content: string } }]>
    const summaryCall = commentCalls.find(([a]) => a.data.content.includes('Claude Code delivered:'))
    expect(summaryCall).toBeDefined()
    expect(summaryCall![0].data.content).toContain('Skipped or rejected')
    expect(summaryCall![0].data.content).toContain('../etc/passwd')
    expect(summaryCall![0].data.content).toContain('/etc/passwd')
    expect(summaryCall![0].data.content).toContain('ok.md')
  })
})

// ─── M3: enriched spec (T5) ───────────────────────────────────────────────────

describe('M3 — enriched spec and runTests:false (T5)', () => {
  it('submitClaudeBuild receives spec containing DELIVERABLE REQUIREMENTS and runTests:false', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(card())
    mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
    mockPrisma.cardExecution.create.mockResolvedValue(exec())
    const c = client()
    __setMcpClientForTests(c)
    await fireExecutionForCard('card-abc12345')
    await flushForTests()
    const call = (c.submitClaudeBuild as ReturnType<typeof vi.fn>).mock.calls[0][0] as { spec: string; runTests: boolean }
    expect(call.spec).toContain('Build login')
    expect(call.spec).toContain('DELIVERABLE REQUIREMENTS')
    expect(call.runTests).toBe(false)
  })
})
