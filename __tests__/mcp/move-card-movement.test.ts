import { describe, it, expect, vi, beforeEach } from 'vitest'

const recordCardMovement = vi.fn().mockResolvedValue({ id: 'mv-1' })
vi.mock('../../src/lib/card-movement', () => ({ recordCardMovement }))
vi.mock('../../src/lib/agent-activity', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/lib/webhook', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined) }))

const mockPrisma = {
  card: { findFirst: vi.fn(), update: vi.fn() },
  column: { findFirst: vi.fn() },
  board: {} as Record<string, unknown>,
  cardMovement: {} as Record<string, unknown>,
  $transaction: vi.fn(),
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const agentCtx = { orgId: 'org-1', agentName: 'AgentSmith', keyId: 'key-1', permissions: [] as string[] }

describe('MCP move_card movement recording', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records a movement with agent attribution (positive)', async () => {
    mockPrisma.card.findFirst.mockResolvedValue({ id: 'card-1', columnId: 'col-1', boardId: 'board-1' })
    mockPrisma.column.findFirst.mockResolvedValue({ id: 'col-2', boardId: 'board-1' })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ card: { update: vi.fn().mockResolvedValue({ id: 'card-1', columnId: 'col-2' }) }, cardMovement: { create: vi.fn() } })
    )

    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const res = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'move_card', params: { cardId: 'card-1', columnId: 'col-2', position: 1 } },
      agentCtx
    )) as { result?: unknown; error?: unknown }

    expect(res.error).toBeUndefined()
    expect(recordCardMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
        fromColumnId: 'col-1', toColumnId: 'col-2',
        movedBy: { id: 'AgentSmith', kind: 'agent' },
      })
    )
  })
})

describe('MCP list_card_movements', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a board\'s movements newest-first (positive)', async () => {
    mockPrisma.board = { findFirst: vi.fn().mockResolvedValue({ id: 'board-1' }) } as never
    mockPrisma.cardMovement = {
      findMany: vi.fn().mockResolvedValue([
        { id: 'mv-2', cardId: 'c1', boardId: 'board-1', fromColumnId: 'col-1', toColumnId: 'col-2', movedById: 'user-1', movedByKind: 'user', movedAt: new Date('2026-06-14T00:00:00Z'), card: { title: 'C1' } },
      ]),
    } as never
    mockPrisma.column = { findMany: vi.fn().mockResolvedValue([{ id: 'col-1', name: 'A' }, { id: 'col-2', name: 'B' }]) } as never

    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const res = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 9, method: 'list_card_movements', params: { boardId: 'board-1' } },
      agentCtx
    )) as { result?: { movements: unknown[]; truncated: boolean }; error?: unknown }

    expect(res.error).toBeUndefined()
    expect(res.result?.movements).toHaveLength(1)
    expect((res.result?.movements[0] as { fromColumn: string }).fromColumn).toBe('A')
  })

  it('rejects when neither boardId nor cardId is given (negative)', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const res = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 10, method: 'list_card_movements', params: {} },
      agentCtx
    )) as { error?: { code: number } }
    expect(res.error?.code).toBe(-32602)
  })

  it('rejects a foreign-org board (IDOR boundary)', async () => {
    mockPrisma.board = { findFirst: vi.fn().mockResolvedValue(null) } as never
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const res = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 11, method: 'list_card_movements', params: { boardId: 'foreign' } },
      agentCtx
    )) as { error?: { code: number } }
    expect(res.error?.code).toBe(-32602)
  })
})
