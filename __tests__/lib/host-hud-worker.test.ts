import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    agentDispatch: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    hudSession: { findUnique: vi.fn() },
    board: { findFirst: vi.fn() },
    changeSet: { create: vi.fn() },
    // Present so the test can assert the worker NEVER mutates the board:
    card: { create: vi.fn(), update: vi.fn() },
    comment: { create: vi.fn() },
  },
}))

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))
vi.mock('../../src/lib/agent-activity', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }))

import { enqueueDispatch, flushForTests, __setMcpClientForTests } from '../../src/lib/host-hud/worker'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function queuedDispatch(over: Record<string, unknown> = {}) {
  return {
    id: 'disp-1',
    orgId: 'org-1',
    hudSessionId: 'hud-1',
    chairId: 'user-1',
    target: 'drive',
    question: 'where is the contract?',
    status: 'queued',
    ...over,
  }
}

function mcp(output: string) {
  return {
    submitDispatch: vi.fn().mockResolvedValue({ jobId: 'job-1', state: 'queued' }),
    pollDispatchStatus: vi.fn().mockResolvedValue({ state: 'done', output }),
  }
}

function findUpdate(predicate: (data: Record<string, unknown>) => boolean) {
  return mockPrisma.agentDispatch.update.mock.calls.find((c) => predicate(c[0].data))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentDispatch.findUnique.mockResolvedValue(queuedDispatch())
  mockPrisma.agentDispatch.update.mockResolvedValue({})
})

afterEach(() => {
  __setMcpClientForTests(null)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('host-hud worker', () => {
  it('stores an answer-only dispatch as done and never touches the board', async () => {
    __setMcpClientForTests(
      mcp(
        JSON.stringify({
          answer: 'It is in /Legal/contract-v3.',
          citations: [{ kind: 'doc', id: 'd1', title: 'contract-v3' }],
          confidence: 0.88,
          suggestion: null,
        })
      )
    )

    enqueueDispatch('disp-1')
    await flushForTests()

    const done = findUpdate((d) => d.status === 'done')
    expect(done).toBeDefined()
    expect(done![0].data.answer).toContain('contract-v3')
    expect(done![0].data.proposedChangeSetId).toBeNull()

    // READ-ONLY GUARANTEE: no board mutation, no proposal.
    expect(mockPrisma.changeSet.create).not.toHaveBeenCalled()
    expect(mockPrisma.card.update).not.toHaveBeenCalled()
    expect(mockPrisma.card.create).not.toHaveBeenCalled()
    expect(mockPrisma.comment.create).not.toHaveBeenCalled()
  }, 10000)

  it('turns a suggested change into a PENDING ChangeSet (never applies it)', async () => {
    mockPrisma.changeSet.create.mockResolvedValue({ id: 'cs-1', items: [{ id: 'ci-1' }] })

    __setMcpClientForTests(
      mcp(
        JSON.stringify({
          answer: 'That card looks done — suggest moving it.',
          citations: [],
          confidence: 0.7,
          suggestion: {
            summary: 'mark handover done',
            items: [
              { op: 'comment_card', payload: { cardId: 'card-9', content: 'Confirmed done in meeting' } },
            ],
          },
        })
      )
    )

    enqueueDispatch('disp-1')
    await flushForTests()

    expect(mockPrisma.changeSet.create).toHaveBeenCalledTimes(1)
    const done = findUpdate((d) => d.status === 'done')
    expect(done![0].data.proposedChangeSetId).toBe('cs-1')

    // The proposal is NOT applied: no direct comment/card mutation happened.
    expect(mockPrisma.card.update).not.toHaveBeenCalled()
    expect(mockPrisma.comment.create).not.toHaveBeenCalled()
  }, 10000)

  it('marks the dispatch failed when ClaudeMCP submission throws', async () => {
    __setMcpClientForTests({
      submitDispatch: vi.fn().mockRejectedValue(new Error('mcp down')),
      pollDispatchStatus: vi.fn(),
    })

    enqueueDispatch('disp-1')
    await flushForTests()

    const failed = findUpdate((d) => d.status === 'failed')
    expect(failed).toBeDefined()
    expect(failed![0].data.error).toContain('mcp down')
  }, 10000)
})
