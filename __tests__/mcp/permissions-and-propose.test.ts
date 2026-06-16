/**
 * MCP permission scoping + propose_changeset, exercised through handleMcpRequest.
 * Proves a read-scoped key cannot mutate even when explicitly asked to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    board: { findFirst: vi.fn() },
    card: { findFirst: vi.fn(), update: vi.fn() },
    column: { findFirst: vi.fn() },
    changeSet: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  },
}))

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))
vi.mock('../../src/lib/agent-activity', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/lib/webhook', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined) }))

import { handleMcpRequest } from '../../src/lib/mcp-server'

const readScoped = { orgId: 'org-1', agentName: 'meeting-hud', keyId: 'k1', permissions: ['read', 'propose'] }

function rpc(method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 1, method, params }
}

beforeEach(() => vi.clearAllMocks())

describe('read-scoped MCP key', () => {
  it('is denied move_card and never mutates the card', async () => {
    const res = (await handleMcpRequest(
      rpc('move_card', { cardId: 'c1', columnId: 'col2', position: 1 }),
      readScoped
    )) as { error?: { code: number; message: string } }

    expect(res.error).toBeDefined()
    expect(res.error!.code).toBe(-32004)
    expect(res.error!.message).toMatch(/Permission denied/i)
    expect(mockPrisma.card.update).not.toHaveBeenCalled()
  })

  it('can propose a changeset, which creates a PENDING ChangeSet', async () => {
    mockPrisma.board.findFirst.mockResolvedValue({ id: 'board-1' })
    mockPrisma.changeSet.create.mockResolvedValue({ id: 'cs-1', status: 'pending', items: [{ id: 'i1' }] })

    const res = (await handleMcpRequest(
      rpc('propose_changeset', {
        boardId: 'board-1',
        summary: 'move the handover card',
        items: [{ op: 'move_card', payload: { cardId: 'c1', columnId: 'col-done', position: 1 } }],
      }),
      readScoped
    )) as { result?: { changeSetId: string; status: string } }

    expect(mockPrisma.changeSet.create).toHaveBeenCalledTimes(1)
    expect(res.result?.changeSetId).toBe('cs-1')
    expect(res.result?.status).toBe('pending')
    // proposal only — no direct board mutation
    expect(mockPrisma.card.update).not.toHaveBeenCalled()
  })

  it('rejects a propose_changeset with an invalid op payload', async () => {
    const res = (await handleMcpRequest(
      rpc('propose_changeset', {
        items: [{ op: 'move_card', payload: { cardId: 'c1' } }], // missing columnId/position
      }),
      readScoped
    )) as { error?: { code: number; message: string } }

    expect(res.error).toBeDefined()
    expect(res.error!.code).toBe(-32602)
    expect(mockPrisma.changeSet.create).not.toHaveBeenCalled()
  })
})
