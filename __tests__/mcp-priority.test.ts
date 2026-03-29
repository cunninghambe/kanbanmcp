/**
 * Tests for MCP server priority field support
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  board: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  column: {
    findFirst: vi.fn(),
  },
  card: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    aggregate: vi.fn(),
  },
  orgMember: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  sprint: {
    findMany: vi.fn(),
  },
  comment: {
    create: vi.fn(),
  },
  agentActivity: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
}

vi.mock('../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

vi.mock('../src/lib/agent-activity', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/lib/webhook', () => ({
  dispatchWebhook: vi.fn().mockResolvedValue(undefined),
}))

const agentCtx = {
  orgId: 'org-1',
  agentName: 'test-agent',
  keyId: 'key-1',
  permissions: ['*'],
}

function makeRpc(method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 1, method, params }
}

// ─── isValidPriority via create_card ─────────────────────────────────────────
describe('MCP priority field - create_card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.board.findFirst.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    mockPrisma.column.findFirst.mockResolvedValue({ id: 'col-1', boardId: 'board-1' })
    mockPrisma.card.aggregate.mockResolvedValue({ _max: { position: 0 } })
    mockPrisma.orgMember.findFirst.mockResolvedValue({ userId: 'user-1' })
  })

  it('creates card with explicit valid priority', async () => {
    mockPrisma.card.create.mockResolvedValue({
      id: 'card-1', title: 'Test', priority: 'high', boardId: 'board-1', columnId: 'col-1',
    })
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    const result = await handleMcpRequest(
      makeRpc('create_card', { boardId: 'board-1', columnId: 'col-1', title: 'Test', priority: 'high' }),
      agentCtx
    ) as { result: { priority: string } }
    expect(result.result.priority).toBe('high')
    expect(mockPrisma.card.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priority: 'high' }) })
    )
  })

  it('creates card with default priority "none" when priority not provided', async () => {
    mockPrisma.card.create.mockResolvedValue({
      id: 'card-1', title: 'Test', priority: 'none', boardId: 'board-1', columnId: 'col-1',
    })
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    const result = await handleMcpRequest(
      makeRpc('create_card', { boardId: 'board-1', columnId: 'col-1', title: 'Test' }),
      agentCtx
    ) as { result: { priority: string } }
    expect(mockPrisma.card.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priority: 'none' }) })
    )
  })

  it('rejects invalid priority string', async () => {
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    const result = await handleMcpRequest(
      makeRpc('create_card', { boardId: 'board-1', columnId: 'col-1', title: 'Test', priority: 'urgent' }),
      agentCtx
    ) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('priority')
  })

  it('rejects priority as a number (not a string)', async () => {
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    const result = await handleMcpRequest(
      makeRpc('create_card', { boardId: 'board-1', columnId: 'col-1', title: 'Test', priority: 3 }),
      agentCtx
    ) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('priority')
  })
})

// ─── update_card priority ─────────────────────────────────────────────────────
describe('MCP priority field - update_card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.card.findFirst.mockResolvedValue({
      id: 'card-1', boardId: 'board-1', columnId: 'col-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1' })
  })

  it('updates priority when valid value provided', async () => {
    mockPrisma.card.update.mockResolvedValue({ id: 'card-1', priority: 'critical' })
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    const result = await handleMcpRequest(
      makeRpc('update_card', { cardId: 'card-1', priority: 'critical' }),
      agentCtx
    ) as { result: { priority: string } }
    expect(result.result.priority).toBe('critical')
    expect(mockPrisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priority: 'critical' }) })
    )
  })

  it('returns error when explicitly invalid priority string provided', async () => {
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    const result = await handleMcpRequest(
      makeRpc('update_card', { cardId: 'card-1', title: 'New title', priority: 'INVALID' }),
      agentCtx
    ) as { error?: { message: string; code: number } }
    // Explicitly invalid priority values should produce an error
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('priority')
    // The card should NOT be updated
    expect(mockPrisma.card.update).not.toHaveBeenCalled()
  })

  it('does not include priority in update when priority not provided', async () => {
    mockPrisma.card.update.mockResolvedValue({ id: 'card-1', title: 'Updated' })
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    await handleMcpRequest(
      makeRpc('update_card', { cardId: 'card-1', title: 'Updated' }),
      agentCtx
    )
    expect(mockPrisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ priority: expect.anything() })
      })
    )
  })

  it('rejects invalid dueDate format', async () => {
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    const result = await handleMcpRequest(
      makeRpc('update_card', { cardId: 'card-1', dueDate: 'not-a-date' }),
      agentCtx
    ) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('dueDate')
  })

  it('rejects empty title string', async () => {
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    const result = await handleMcpRequest(
      makeRpc('update_card', { cardId: 'card-1', title: '' }),
      agentCtx
    ) as { error: { message: string } }
    expect(result.error).toBeDefined()
    expect(result.error.message).toContain('title')
  })
})

// ─── All 5 valid priority values tested via isValidPriority ─────────────────
describe('MCP priority validation - all valid values', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.card.findFirst.mockResolvedValue({
      id: 'card-1', boardId: 'board-1', columnId: 'col-1',
      board: { orgId: 'org-1' },
    })
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1' })
  })

  it.each(['none', 'low', 'medium', 'high', 'critical'])('accepts priority "%s"', async (priority) => {
    mockPrisma.card.update.mockResolvedValue({ id: 'card-1', priority })
    const { handleMcpRequest } = await import('../src/lib/mcp-server')
    const result = await handleMcpRequest(
      makeRpc('update_card', { cardId: 'card-1', priority }),
      agentCtx
    ) as { result?: unknown; error?: { message: string } }
    expect(result.error).toBeUndefined()
    expect(result.result).toBeDefined()
  })

  it.each([null, undefined, 123, '', 'CRITICAL', 'urgent', 'blocker'])(
    'rejects or ignores invalid priority "%s"',
    async (priority) => {
      mockPrisma.card.update.mockResolvedValue({ id: 'card-1' })
      const { handleMcpRequest } = await import('../src/lib/mcp-server')
      await handleMcpRequest(
        makeRpc('update_card', { cardId: 'card-1', title: 'Keep', priority }),
        agentCtx
      )
      // Either error returned or priority not included in update
      // Both are acceptable outcomes for invalid values
      if (mockPrisma.card.update.mock.calls.length > 0) {
        const updateCall = mockPrisma.card.update.mock.calls[0][0]
        expect(updateCall.data).not.toHaveProperty('priority')
      }
    }
  )
})
