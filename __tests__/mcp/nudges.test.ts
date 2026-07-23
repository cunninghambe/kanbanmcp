/**
 * create_nudge MCP tool, exercised through handleMcpRequest.
 * Covers create, per-thread dedup, write-scope gating, and card org-scoping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    nudge: { findFirst: vi.fn(), create: vi.fn() },
    card: { findFirst: vi.fn() },
  },
}))

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))
vi.mock('../../src/lib/agent-activity', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/lib/webhook', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined) }))

import { handleMcpRequest } from '../../src/lib/mcp-server'

const writeScoped = { orgId: 'org-1', agentName: 'inbox-agent', keyId: 'k1', permissions: ['write'] }
const readScoped = { orgId: 'org-1', agentName: 'meeting-hud', keyId: 'k2', permissions: ['read', 'propose'] }

function rpc(method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 1, method, params }
}

beforeEach(() => vi.clearAllMocks())

describe('create_nudge', () => {
  it('is denied for a ["read","propose"] key (-32004) and never creates', async () => {
    const res = (await handleMcpRequest(
      rpc('create_nudge', { title: 'Jane: urgent' }),
      readScoped
    )) as { error?: { code: number; message: string } }

    expect(res.error).toBeDefined()
    expect(res.error!.code).toBe(-32004)
    expect(res.error!.message).toMatch(/Permission denied/i)
    expect(mockPrisma.nudge.create).not.toHaveBeenCalled()
  })

  it('creates a nudge for a ["write"] key and returns { nudgeId, deduped: false }', async () => {
    mockPrisma.nudge.findFirst.mockResolvedValue(null)
    mockPrisma.nudge.create.mockResolvedValue({ id: 'nudge-1' })

    const res = (await handleMcpRequest(
      rpc('create_nudge', {
        title: 'Jane Doe: contract needs signing',
        summary: 'please sign today',
        fromLabel: 'Jane Doe',
        gmailThreadId: 'thread-abc',
        permalink: 'https://mail.google.com/x',
      }),
      writeScoped
    )) as { result?: { nudgeId: string; deduped: boolean } }

    expect(mockPrisma.nudge.create).toHaveBeenCalledTimes(1)
    expect(res.result).toEqual({ nudgeId: 'nudge-1', deduped: false })
    const createArg = mockPrisma.nudge.create.mock.calls[0][0]
    expect(createArg.data.orgId).toBe('org-1')
    expect(createArg.data.createdById).toBe('inbox-agent')
  })

  it('dedupes on an existing pending nudge for the same thread', async () => {
    mockPrisma.nudge.findFirst.mockResolvedValue({ id: 'existing-9' })

    const res = (await handleMcpRequest(
      rpc('create_nudge', { title: 'Jane: urgent', gmailThreadId: 'thread-abc' }),
      writeScoped
    )) as { result?: { nudgeId: string; deduped: boolean } }

    expect(res.result).toEqual({ nudgeId: 'existing-9', deduped: true })
    expect(mockPrisma.nudge.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-1', gmailThreadId: 'thread-abc', status: 'pending' },
      })
    )
    expect(mockPrisma.nudge.create).not.toHaveBeenCalled()
  })

  it('requires a title', async () => {
    const res = (await handleMcpRequest(
      rpc('create_nudge', {}),
      writeScoped
    )) as { error?: { code: number; message: string } }

    expect(res.error!.code).toBe(-32602)
    expect(mockPrisma.nudge.create).not.toHaveBeenCalled()
  })

  it('silently nulls a cardId that does not belong to the org', async () => {
    mockPrisma.nudge.findFirst.mockResolvedValue(null)
    mockPrisma.card.findFirst.mockResolvedValue(null) // foreign / missing card
    mockPrisma.nudge.create.mockResolvedValue({ id: 'nudge-2' })

    const res = (await handleMcpRequest(
      rpc('create_nudge', { title: 'x', cardId: 'foreign-card' }),
      writeScoped
    )) as { result?: { nudgeId: string; deduped: boolean } }

    expect(res.result).toEqual({ nudgeId: 'nudge-2', deduped: false })
    const createArg = mockPrisma.nudge.create.mock.calls[0][0]
    expect(createArg.data.cardId).toBeNull()
  })

  it('keeps a cardId that belongs to the org', async () => {
    mockPrisma.nudge.findFirst.mockResolvedValue(null)
    mockPrisma.card.findFirst.mockResolvedValue({ id: 'card-7' })
    mockPrisma.nudge.create.mockResolvedValue({ id: 'nudge-3' })

    await handleMcpRequest(rpc('create_nudge', { title: 'x', cardId: 'card-7' }), writeScoped)

    const createArg = mockPrisma.nudge.create.mock.calls[0][0]
    expect(createArg.data.cardId).toBe('card-7')
  })
})
