import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    agentDispatch: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    hudSession: { findUnique: vi.fn() },
    board: { findFirst: vi.fn(), findMany: vi.fn() },
    column: { findMany: vi.fn() },
    changeSet: { create: vi.fn() },
    // Present so the test can assert the worker NEVER mutates the board:
    card: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
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
    cancelDispatch: vi.fn().mockResolvedValue(undefined),
  }
}

function findUpdate(predicate: (data: Record<string, unknown>) => boolean) {
  return mockPrisma.agentDispatch.update.mock.calls.find((c) => predicate(c[0].data))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentDispatch.findUnique.mockResolvedValue(queuedDispatch())
  mockPrisma.agentDispatch.update.mockResolvedValue({})
  // Default: the queued→running claim succeeds.
  mockPrisma.agentDispatch.updateMany.mockResolvedValue({ count: 1 })
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
    // card-9 resolves in-org → propose-time validation passes.
    mockPrisma.card.findMany.mockResolvedValue([{ id: 'card-9' }])

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

  it('drops a cross-org item from the suggestion and proposes only the in-org items', async () => {
    // card-9 is in-org; card-foreign belongs to another org (absent from findMany).
    mockPrisma.card.findMany.mockResolvedValue([{ id: 'card-9' }])
    mockPrisma.changeSet.create.mockResolvedValue({ id: 'cs-1', items: [{ id: 'ci-1' }] })

    __setMcpClientForTests(
      mcp(
        JSON.stringify({
          answer: 'Two suggestions, one references another workspace.',
          citations: [],
          confidence: 0.6,
          suggestion: {
            summary: 'mixed',
            items: [
              { op: 'comment_card', payload: { cardId: 'card-9', content: 'ok' } },
              { op: 'comment_card', payload: { cardId: 'card-foreign', content: 'leak attempt' } },
            ],
          },
        })
      )
    )

    enqueueDispatch('disp-1')
    await flushForTests()

    expect(mockPrisma.changeSet.create).toHaveBeenCalledTimes(1)
    const created = mockPrisma.changeSet.create.mock.calls[0][0].data.items.create as Array<{ payload: string }>
    expect(created).toHaveLength(1)
    expect(created[0].payload).toContain('card-9')
    expect(JSON.stringify(created)).not.toContain('card-foreign')

    const done = findUpdate((d) => d.status === 'done')
    expect(done![0].data.proposedChangeSetId).toBe('cs-1')
  }, 10000)

  it('creates NO ChangeSet when every suggested item references a cross-org id', async () => {
    mockPrisma.card.findMany.mockResolvedValue([]) // nothing in-org

    __setMcpClientForTests(
      mcp(
        JSON.stringify({
          answer: 'The only suggestion targets a foreign card.',
          citations: [],
          confidence: 0.5,
          suggestion: {
            summary: 'leak',
            items: [{ op: 'comment_card', payload: { cardId: 'card-foreign', content: 'x' } }],
          },
        })
      )
    )

    enqueueDispatch('disp-1')
    await flushForTests()

    // Dispatch still completes; the proposal is simply dropped.
    expect(mockPrisma.changeSet.create).not.toHaveBeenCalled()
    const done = findUpdate((d) => d.status === 'done')
    expect(done).toBeDefined()
    expect(done![0].data.proposedChangeSetId).toBeNull()
  }, 10000)

  it('marks the dispatch failed when ClaudeMCP submission throws', async () => {
    __setMcpClientForTests({
      submitDispatch: vi.fn().mockRejectedValue(new Error('mcp down')),
      pollDispatchStatus: vi.fn(),
      cancelDispatch: vi.fn(),
    })

    enqueueDispatch('disp-1')
    await flushForTests()

    const failed = findUpdate((d) => d.status === 'failed')
    expect(failed).toBeDefined()
    expect(failed![0].data.error).toContain('mcp down')
  }, 10000)

  it('propagates a chair cancellation to ClaudeMCP and does not finish the dispatch', async () => {
    // First read returns the running dispatch; the in-poll status read reports it
    // was cancelled (by the cancel route or an ending session).
    mockPrisma.agentDispatch.findUnique.mockReset()
    mockPrisma.agentDispatch.findUnique
      .mockResolvedValueOnce(queuedDispatch())
      .mockResolvedValue({ status: 'cancelled' })

    const client = {
      submitDispatch: vi.fn().mockResolvedValue({ jobId: 'job-1', state: 'queued' }),
      pollDispatchStatus: vi.fn().mockResolvedValue({ state: 'running' }),
      cancelDispatch: vi.fn().mockResolvedValue(undefined),
    }
    __setMcpClientForTests(client)

    enqueueDispatch('disp-1')
    await flushForTests()

    expect(client.cancelDispatch).toHaveBeenCalledTimes(1)
    expect(client.cancelDispatch).toHaveBeenCalledWith('job-1')
    // The external job is never polled to completion, so no done/failed write.
    expect(findUpdate((d) => d.status === 'done')).toBeUndefined()
    expect(findUpdate((d) => d.status === 'failed')).toBeUndefined()
  }, 10000)

  it('bails out without submitting when a cancel lands before the running claim', async () => {
    // The initial read sees `queued`, but by the time the worker tries the
    // conditional queued→running claim the cancel route has already flipped the
    // row to `cancelled` — the claim matches nothing and the worker must not
    // overwrite the cancellation or submit an external job.
    mockPrisma.agentDispatch.updateMany.mockResolvedValue({ count: 0 })

    const client = mcp('should never be used')
    __setMcpClientForTests(client)

    enqueueDispatch('disp-1')
    await flushForTests()

    // The claim was attempted with the in-flight status guard…
    expect(mockPrisma.agentDispatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'disp-1', status: { in: ['queued', 'running'] } }),
        data: expect.objectContaining({ status: 'running' }),
      })
    )
    // …and on count 0 the worker bailed: no external job, no status overwrite.
    expect(client.submitDispatch).not.toHaveBeenCalled()
    expect(mockPrisma.agentDispatch.update).not.toHaveBeenCalled()
  }, 10000)
})
