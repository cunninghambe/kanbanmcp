/**
 * Tests for the six new MCP tools added in M1.07:
 * create_subcard, set_card_reviewers, toggle_ai_review,
 * list_card_tree, record_signoff, list_artifacts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  board: { findFirst: vi.fn() },
  column: { findFirst: vi.fn() },
  card: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    aggregate: vi.fn(),
  },
  orgMember: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  sprint: { findMany: vi.fn() },
  comment: { create: vi.fn() },
  agentActivity: { findMany: vi.fn(), count: vi.fn() },
  artifact: { findMany: vi.fn() },
  signoff: { findMany: vi.fn() },
}

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))
vi.mock('../../src/lib/agent-activity', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/lib/webhook', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/lib/ai-review/queue', () => ({
  enqueueAiReview: vi.fn().mockResolvedValue(undefined),
}))

const agentCtx = { orgId: 'org-1', agentName: 'test-agent', keyId: 'key-1', permissions: ['*'] }

function makeRpc(method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 1, method, params }
}

const parentCard = {
  id: 'parent-1',
  path: '',
  depth: 0,
  columnId: 'col-1',
  boardId: 'board-1',
  board: { orgId: 'org-1' },
}

const baseCard = {
  id: 'card-1',
  title: 'Test',
  description: null,
  parentCardId: null,
  path: '',
  depth: 0,
  aiAutoReview: false,
  aiReviewParams: null,
  assigneeId: 'user-1',
  reviewerId: null,
  approverId: null,
  assignee: null,
  reviewer: null,
  approver: null,
  board: { orgId: 'org-1' },
  boardId: 'board-1',
  columnId: 'col-1',
}

function makeArtifact(id: string) {
  return {
    id,
    cardId: 'card-1',
    uploaderId: 'user-1',
    filename: `file-${id}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 512,
    storageKey: id,
    source: 'UPLOAD',
    createdAt: new Date('2026-01-01'),
    uploader: {
      id: 'user-1',
      name: 'Alice',
      email: 'alice@example.com',
      passwordHash: 'h',
      isAgent: false,
      createdAt: new Date(),
    },
    reviews: [],
  }
}

// ─── create_subcard ───────────────────────────────────────────────────────────
describe('create_subcard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.card.findFirst.mockResolvedValue(parentCard)
    mockPrisma.orgMember.findMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }])
    mockPrisma.orgMember.findFirst.mockResolvedValue({ userId: 'user-1' })
    mockPrisma.card.aggregate.mockResolvedValue({ _max: { position: 2 } })
  })

  it('creates a subcard with correct parentCardId, path, and depth (AC-13)', async () => {
    mockPrisma.card.create.mockResolvedValue({
      id: 'child-1',
      title: 'Child',
      parentCardId: 'parent-1',
      path: '/parent-1/',
      depth: 1,
      boardId: 'board-1',
      columnId: 'col-1',
    })

    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('create_subcard', { parentCardId: 'parent-1', title: 'Child', assigneeId: 'user-1' }),
      agentCtx
    )) as { result: { parentCardId: string; path: string; depth: number } }

    expect(result.result.parentCardId).toBe('parent-1')
    expect(result.result.path).toBe('/parent-1/')
    expect(result.result.depth).toBe(1)

    expect(mockPrisma.card.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parentCardId: 'parent-1',
          path: '/parent-1/',
          depth: 1,
          assigneeId: 'user-1',
        }),
      })
    )
  })

  it('inherits parent columnId when columnId not provided', async () => {
    mockPrisma.card.create.mockResolvedValue({
      id: 'child-1',
      title: 'Child',
      parentCardId: 'parent-1',
      path: '/parent-1/',
      depth: 1,
    })
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    await handleMcpRequest(
      makeRpc('create_subcard', { parentCardId: 'parent-1', title: 'Child', assigneeId: 'user-1' }),
      agentCtx
    )
    expect(mockPrisma.card.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ columnId: 'col-1' }) })
    )
  })

  it('rejects when parentCardId is missing', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('create_subcard', { title: 'Child', assigneeId: 'user-1' }),
      agentCtx
    )) as { error: { code: number; message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('parentCardId')
  })

  it('rejects when assigneeId is missing', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('create_subcard', { parentCardId: 'parent-1', title: 'Child' }),
      agentCtx
    )) as { error: { code: number; message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('assigneeId')
  })

  it('rejects when parent card is in a different org (cross-org IDOR)', async () => {
    mockPrisma.card.findFirst.mockResolvedValue(null)
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('create_subcard', {
        parentCardId: 'parent-other-org',
        title: 'Child',
        assigneeId: 'user-1',
      }),
      agentCtx
    )) as { error: { code: number; message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('not found')
  })

  it('rejects when depth would exceed MAX_NESTING_DEPTH', async () => {
    mockPrisma.card.findFirst.mockResolvedValue({ ...parentCard, depth: 49 })
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('create_subcard', { parentCardId: 'parent-1', title: 'Child', assigneeId: 'user-1' }),
      agentCtx
    )) as { error: { code: number; message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('Maximum nesting depth')
  })

  it('rejects when assignee is not an org member', async () => {
    mockPrisma.orgMember.findMany.mockResolvedValue([])
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('create_subcard', {
        parentCardId: 'parent-1',
        title: 'Child',
        assigneeId: 'outsider',
      }),
      agentCtx
    )) as { error: { code: number; message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('not a member')
  })
})

// ─── set_card_reviewers ───────────────────────────────────────────────────────
describe('set_card_reviewers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.card.findFirst.mockResolvedValue(baseCard)
    mockPrisma.orgMember.findMany.mockResolvedValue([{ userId: 'user-2' }])
  })

  it('sets reviewerId on a card', async () => {
    mockPrisma.card.update.mockResolvedValue({ ...baseCard, reviewerId: 'user-2' })
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('set_card_reviewers', { cardId: 'card-1', reviewerId: 'user-2' }),
      agentCtx
    )) as { result: { reviewerId: string } }
    expect(result.result.reviewerId).toBe('user-2')
    expect(mockPrisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewerId: 'user-2' }) })
    )
  })

  it('clears reviewerId when set to null', async () => {
    mockPrisma.card.update.mockResolvedValue({ ...baseCard, reviewerId: null })
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('set_card_reviewers', { cardId: 'card-1', reviewerId: null }),
      agentCtx
    )) as { result: { reviewerId: null } }
    expect(result.result.reviewerId).toBeNull()
    expect(mockPrisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewerId: null }) })
    )
  })

  it('rejects when cardId is missing', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('set_card_reviewers', { reviewerId: 'user-2' }),
      agentCtx
    )) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('cardId')
  })

  it('rejects when reviewer is not an org member (IDOR check)', async () => {
    mockPrisma.orgMember.findMany.mockResolvedValue([])
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('set_card_reviewers', { cardId: 'card-1', reviewerId: 'outsider' }),
      agentCtx
    )) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('not a member')
  })

  it('rejects cross-org card access', async () => {
    mockPrisma.card.findFirst.mockResolvedValue(null)
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('set_card_reviewers', { cardId: 'card-other-org', reviewerId: 'user-2' }),
      agentCtx
    )) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('not found')
  })
})

// ─── toggle_ai_review ─────────────────────────────────────────────────────────
describe('toggle_ai_review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.card.findFirst.mockResolvedValue(baseCard)
  })

  it('enables aiAutoReview without params', async () => {
    mockPrisma.card.update.mockResolvedValue({
      ...baseCard,
      aiAutoReview: true,
      aiReviewParams: null,
    })
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('toggle_ai_review', { cardId: 'card-1', enabled: true }),
      agentCtx
    )) as { result: { aiAutoReview: boolean } }
    expect(result.result.aiAutoReview).toBe(true)
    expect(mockPrisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ aiAutoReview: true }) })
    )
  })

  it('sets aiReviewParams when params provided', async () => {
    const reviewParams = { model: 'claude-sonnet-4-6', rubric: 'Check for clarity.' }
    mockPrisma.card.update.mockResolvedValue({
      ...baseCard,
      aiAutoReview: true,
      aiReviewParams: JSON.stringify(reviewParams),
    })
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('toggle_ai_review', { cardId: 'card-1', enabled: true, params: reviewParams }),
      agentCtx
    )) as { result: { aiAutoReview: boolean; aiReviewParams: unknown } }
    expect(result.result.aiAutoReview).toBe(true)
    expect(result.result.aiReviewParams).toMatchObject(reviewParams)
  })

  it('returns -32602 when params is missing rubric', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('toggle_ai_review', {
        cardId: 'card-1',
        enabled: true,
        params: { model: 'claude-sonnet-4-6' },
      }),
      agentCtx
    )) as { error: { code: number; message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.code).toBe(-32602)
  })

  it('returns -32602 when params has rubric exceeding max length', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('toggle_ai_review', {
        cardId: 'card-1',
        enabled: true,
        params: { model: 'claude-sonnet-4-6', rubric: 'x'.repeat(10001) },
      }),
      agentCtx
    )) as { error: { code: number; message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.code).toBe(-32602)
  })

  it('rejects when cardId is missing', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('toggle_ai_review', { enabled: true }),
      agentCtx
    )) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('cardId')
  })
})

// ─── list_card_tree ───────────────────────────────────────────────────────────
describe('list_card_tree', () => {
  const rootNode = {
    id: 'card-root',
    title: 'Root',
    description: null,
    parentCardId: null,
    path: '',
    depth: 0,
    aiAutoReview: false,
    aiReviewParams: null,
    assigneeId: null,
    reviewerId: null,
    approverId: null,
    assignee: null,
    reviewer: null,
    approver: null,
    board: { orgId: 'org-1' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.card.findFirst.mockResolvedValue({
      id: 'card-root',
      boardId: 'board-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.card.findUnique.mockResolvedValue(rootNode)
    mockPrisma.card.findMany.mockResolvedValue([])
    mockPrisma.signoff.findMany.mockResolvedValue([])
  })

  it('returns root and empty descendants (AC-14: matches children endpoint shape)', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('list_card_tree', { cardId: 'card-root' }),
      agentCtx
    )) as { result: { root: { id: string }; descendants: unknown[]; truncated: boolean } }
    expect(result.result.root.id).toBe('card-root')
    expect(result.result.descendants).toEqual([])
    expect(result.result).toHaveProperty('truncated')
  })

  it('returns subtree with descendants', async () => {
    const child = {
      ...rootNode,
      id: 'child-1',
      parentCardId: 'card-root',
      path: '/card-root/',
      depth: 1,
    }
    mockPrisma.card.findMany.mockResolvedValue([child])
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('list_card_tree', { cardId: 'card-root', depth: 1 }),
      agentCtx
    )) as { result: { root: { id: string }; descendants: Array<{ id: string }> } }
    expect(result.result.root.id).toBe('card-root')
    expect(result.result.descendants).toHaveLength(1)
    expect(result.result.descendants[0].id).toBe('child-1')
  })

  it('clamps depth to max 5', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    await handleMcpRequest(makeRpc('list_card_tree', { cardId: 'card-root', depth: 999 }), agentCtx)
    // fetchSubtree is called with clamped depth — card.findMany gets depth lte root.depth+5
    expect(mockPrisma.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ depth: { lte: 5 } }) })
    )
  })

  it('defaults depth to 1 when not provided', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    await handleMcpRequest(makeRpc('list_card_tree', { cardId: 'card-root' }), agentCtx)
    expect(mockPrisma.card.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ depth: { lte: 1 } }) })
    )
  })

  it('rejects cross-org card (IDOR check)', async () => {
    mockPrisma.card.findFirst.mockResolvedValue(null)
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('list_card_tree', { cardId: 'card-other-org' }),
      agentCtx
    )) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('not found')
  })

  it('result shape matches GET /api/cards/[cardId]/children (AC-14)', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('list_card_tree', { cardId: 'card-root' }),
      agentCtx
    )) as { result: Record<string, unknown> }
    // Must have root, descendants, truncated — same keys as the HTTP endpoint
    expect(Object.keys(result.result).sort()).toEqual(['descendants', 'root', 'truncated'].sort())
  })
})

// ─── record_signoff ───────────────────────────────────────────────────────────
describe('record_signoff', () => {
  it('always returns error code -32602 (M1: API key cannot record signoffs)', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('record_signoff', { cardId: 'card-1', role: 'REVIEWER', decision: 'APPROVED' }),
      agentCtx
    )) as { error: { code: number; message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.code).toBe(-32602)
    expect(result.error.message).toContain('human user session')
  })

  it('returns the same error even with valid-looking params', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('record_signoff', {
        cardId: 'card-1',
        role: 'APPROVER',
        decision: 'REJECTED',
        comment: 'Not good enough',
      }),
      agentCtx
    )) as { error: { code: number } }
    expect(result.error.code).toBe(-32602)
  })

  it('never reads or writes any card data (throws before touching DB)', async () => {
    vi.clearAllMocks()
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const before = mockPrisma.card.findFirst.mock.calls.length
    await handleMcpRequest(
      makeRpc('record_signoff', { cardId: 'card-1', role: 'REVIEWER', decision: 'APPROVED' }),
      agentCtx
    )
    // record_signoff throws immediately — DB call count must not increase
    expect(mockPrisma.card.findFirst.mock.calls.length).toBe(before)
  })
})

// ─── list_artifacts ───────────────────────────────────────────────────────────
describe('list_artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.card.findFirst.mockResolvedValue(baseCard)
  })

  it('returns artifacts with uploader and reviews', async () => {
    const art = makeArtifact('art-1')
    mockPrisma.artifact.findMany.mockResolvedValue([art])
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('list_artifacts', { cardId: 'card-1' }),
      agentCtx
    )) as { result: { artifacts: Array<{ id: string; uploader: unknown; reviews: unknown[] }> } }
    expect(result.result.artifacts).toHaveLength(1)
    expect(result.result.artifacts[0].id).toBe('art-1')
    expect(result.result.artifacts[0]).toHaveProperty('uploader')
    expect(result.result.artifacts[0]).toHaveProperty('reviews')
  })

  it('returns empty list when card has no artifacts', async () => {
    mockPrisma.artifact.findMany.mockResolvedValue([])
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('list_artifacts', { cardId: 'card-1' }),
      agentCtx
    )) as { result: { artifacts: unknown[] } }
    expect(result.result.artifacts).toEqual([])
  })

  it('rejects cross-org card access (IDOR)', async () => {
    mockPrisma.card.findFirst.mockResolvedValue(null)
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(
      makeRpc('list_artifacts', { cardId: 'card-other-org' }),
      agentCtx
    )) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('not found')
  })

  it('rejects when cardId is missing', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const result = (await handleMcpRequest(makeRpc('list_artifacts', {}), agentCtx)) as {
      error: { message: string }
    }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('cardId')
  })
})

// ─── Manifest check ───────────────────────────────────────────────────────────
describe('MCP manifest includes all six new tools', () => {
  it('GET manifest returns all six new tool names', async () => {
    const { MCP_TOOLS } = await import('../../src/lib/mcp-server')
    const names = MCP_TOOLS.map((t) => t.name)
    expect(names).toContain('create_subcard')
    expect(names).toContain('set_card_reviewers')
    expect(names).toContain('toggle_ai_review')
    expect(names).toContain('list_card_tree')
    expect(names).toContain('record_signoff')
    expect(names).toContain('list_artifacts')
  })
})
