/**
 * Write-through side effects of planner actions — spec §4.10. Card moves only
 * for assignee items; nudge acks only for the mailbox owner, only with a valid
 * Gmail id, and never when the card move failed. (WI-4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionData } from '../../../src/lib/session'
import type { PlannerItemDTO } from '../../../src/lib/planner/types'

const mockPrisma = vi.hoisted(() => ({
  card: { findUnique: vi.fn(), findFirst: vi.fn() },
  column: { findMany: vi.fn() },
  nudge: { findFirst: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('../../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const activity = vi.hoisted(() => ({ logActivity: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../src/lib/agent-activity', () => ({
  logActivity: (...a: unknown[]) => activity.logActivity(...a),
}))

import {
  applyWriteThrough,
  pickDoneColumn,
  TERMINAL_COLUMNS,
} from '../../../src/lib/planner/write-through'

const SESSION: SessionData = { userId: 'user-1', orgId: 'org-1' }
const COLUMNS = [
  { id: 'col-backlog', name: 'Backlog', position: 0 },
  { id: 'col-progress', name: 'In Progress', position: 1 },
  { id: 'col-done', name: 'Done', position: 2 },
]

function item(over: Partial<PlannerItemDTO> = {}): PlannerItemDTO {
  return {
    id: 'it-1',
    source: 'card',
    sourceKey: 'card:c1',
    title: 'Ship it',
    summary: null,
    url: null,
    priority: 'none',
    dueAt: null,
    startsAt: null,
    endsAt: null,
    status: 'open',
    snoozedUntil: null,
    resolvedBy: null,
    resolvedAt: null,
    prepNotes: null,
    payload: { cardId: 'c1', boardId: 'b1', role: 'assignee' },
    lastSeenAt: '2026-09-16T08:00:00.000Z',
    createdAt: '2026-09-16T08:00:00.000Z',
    updatedAt: '2026-09-16T08:00:00.000Z',
    ...over,
  }
}

function cardRow(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    boardId: 'b1',
    columnId: 'col-progress',
    column: { id: 'col-progress', name: 'In Progress' },
    board: { id: 'b1', orgId: 'org-1', columns: COLUMNS },
    ...over,
  }
}

type Tx = {
  card: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  cardMovement: { create: ReturnType<typeof vi.fn> }
}
let tx: Tx

describe('planner/write-through pickDoneColumn', () => {
  it('prefers an exact "done" column (any case), then any terminal name, else null', () => {
    expect(pickDoneColumn(COLUMNS)).toEqual({ id: 'col-done', name: 'Done' })
    expect(
      pickDoneColumn([
        { id: 'a', name: 'Closed', position: 0 },
        { id: 'b', name: 'DONE', position: 1 },
      ])
    ).toEqual({ id: 'b', name: 'DONE' })
    expect(
      pickDoneColumn([
        { id: 'a', name: 'Shipped', position: 1 },
        { id: 'b', name: 'Closed', position: 0 },
      ])
    ).toEqual({ id: 'a', name: 'Shipped' })
    expect(pickDoneColumn([{ id: 'a', name: 'Backlog', position: 0 }])).toBeNull()
    expect([...TERMINAL_COLUMNS].sort()).toEqual(['archived', 'closed', 'done', 'shipped'])
  })
})

describe('planner/write-through applyWriteThrough', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('INBOX_AGENT_OWNER', 'owner@example.com')
    vi.stubEnv('INBOX_AGENT_URL', 'https://script/exec')
    vi.stubEnv('INBOX_AGENT_TOKEN', 'server-token')
    mockPrisma.user.findUnique.mockResolvedValue({ email: 'owner@example.com' })
    mockPrisma.card.findUnique.mockResolvedValue(cardRow())
    mockPrisma.card.findFirst.mockResolvedValue(cardRow())
    mockPrisma.column.findMany.mockResolvedValue(COLUMNS)
    tx = {
      card: {
        findFirst: vi.fn().mockResolvedValue({ position: 4 }),
        update: vi.fn().mockResolvedValue({}),
      },
      cardMovement: { create: vi.fn().mockResolvedValue({ id: 'mv-1' }) },
    }
    mockPrisma.$transaction.mockImplementation(async (fn: (t: Tx) => Promise<unknown>) => fn(tx))
    mockPrisma.nudge.findFirst.mockResolvedValue({
      id: 'n1',
      orgId: 'org-1',
      status: 'pending',
      gmailThreadId: 'thread123',
    })
    mockPrisma.nudge.update.mockResolvedValue({})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ acked: true }) })
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('done on an assignee card moves it to the Done column, appends position, records the movement and logs activity', async () => {
    const res = await applyWriteThrough({
      prisma: mockPrisma as never,
      item: item(),
      action: 'done',
      session: SESSION,
    })
    expect(res).toEqual([
      { kind: 'card_moved', ok: true, cardId: 'c1', toColumnId: 'col-done', toColumnName: 'Done' },
    ])

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { columnId: 'col-done', position: 5 },
    })
    expect(tx.cardMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cardId: 'c1',
          boardId: 'b1',
          orgId: 'org-1',
          fromColumnId: 'col-progress',
          toColumnId: 'col-done',
          movedById: 'user-1',
          movedByKind: 'user',
        }),
      })
    )
    expect(activity.logActivity).toHaveBeenCalledWith(
      'org-1',
      'planner',
      'move_card',
      'card',
      'c1',
      expect.objectContaining({ toColumnId: 'col-done', via: 'planner_done' })
    )
  })

  it('starts at position 0 in an empty Done column and treats a legacy item without a role as an assignee', async () => {
    tx.card.findFirst.mockResolvedValue(null)
    const res = await applyWriteThrough({
      prisma: mockPrisma as never,
      item: item({ payload: { cardId: 'c1', boardId: 'b1' } }),
      action: 'done',
      session: SESSION,
    })
    expect(res[0]).toMatchObject({ kind: 'card_moved', ok: true })
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { columnId: 'col-done', position: 0 },
    })
  })

  it('done on a reviewer or approver item resolves in the planner only: no move, no movement row, no activity', async () => {
    for (const role of ['reviewer', 'approver']) {
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: item({ payload: { cardId: 'c1', boardId: 'b1', role } }),
        action: 'done',
        session: SESSION,
      })
      expect(res).toEqual([{ kind: 'none', ok: true, reason: 'not_applicable' }])
    }
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(tx.card.update).not.toHaveBeenCalled()
    expect(activity.logActivity).not.toHaveBeenCalled()
  })

  it('reports no_done_column when the board has no terminal column, without a transaction', async () => {
    const cols = [
      { id: 'a', name: 'Backlog', position: 0 },
      { id: 'b', name: 'Doing', position: 1 },
    ]
    mockPrisma.card.findUnique.mockResolvedValue(
      cardRow({ board: { id: 'b1', orgId: 'org-1', columns: cols } })
    )
    mockPrisma.card.findFirst.mockResolvedValue(
      cardRow({ board: { id: 'b1', orgId: 'org-1', columns: cols } })
    )
    mockPrisma.column.findMany.mockResolvedValue(cols)
    const res = await applyWriteThrough({
      prisma: mockPrisma as never,
      item: item(),
      action: 'done',
      session: SESSION,
    })
    expect(res).toEqual([{ kind: 'none', ok: true, reason: 'no_done_column' }])
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('reports card_missing when the card is gone or belongs to another org', async () => {
    mockPrisma.card.findUnique.mockResolvedValue(null)
    mockPrisma.card.findFirst.mockResolvedValue(null)
    expect(
      await applyWriteThrough({
        prisma: mockPrisma as never,
        item: item(),
        action: 'done',
        session: SESSION,
      })
    ).toEqual([{ kind: 'none', ok: true, reason: 'card_missing' }])

    mockPrisma.card.findUnique.mockResolvedValue(
      cardRow({ board: { id: 'b1', orgId: 'org-OTHER', columns: COLUMNS } })
    )
    mockPrisma.card.findFirst.mockResolvedValue(null)
    expect(
      await applyWriteThrough({
        prisma: mockPrisma as never,
        item: item(),
        action: 'done',
        session: SESSION,
      })
    ).toEqual([{ kind: 'none', ok: true, reason: 'card_missing' }])
    expect(tx.card.update).not.toHaveBeenCalled()
  })

  it('a failed card move comes back as ok:false without throwing', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('db locked'))
    const res = await applyWriteThrough({
      prisma: mockPrisma as never,
      item: item(),
      action: 'done',
      session: SESSION,
    })
    expect(res).toEqual([{ kind: 'card_moved', ok: false, error: 'db locked' }])
  })

  describe('email items', () => {
    const emailItem = (over: Partial<PlannerItemDTO> = {}) =>
      item({
        source: 'email',
        sourceKey: 'email:e1',
        payload: {
          cardId: 'c1',
          boardId: 'b1',
          gmailThreadId: 'thread123',
          nudgeId: 'n1',
          urgent: true,
        },
        ...over,
      })

    it('done moves the inbox card, then acks the nudge and clears the Gmail label (owner)', async () => {
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: emailItem(),
        action: 'done',
        session: SESSION,
      })
      expect(res).toEqual([
        {
          kind: 'card_moved',
          ok: true,
          cardId: 'c1',
          toColumnId: 'col-done',
          toColumnName: 'Done',
        },
        { kind: 'nudge_acked', ok: true, nudgeId: 'n1' },
      ])
      expect(mockPrisma.nudge.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'n1', orgId: 'org-1', status: 'pending' }),
        })
      )
      const upd = mockPrisma.nudge.update.mock.calls[0][0]
      expect(upd.where).toEqual({ id: 'n1' })
      expect(upd.data).toMatchObject({ status: 'acked', ackedById: 'user-1' })
      expect(upd.data.ackedAt).toBeInstanceOf(Date)

      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://script/exec')
      expect(JSON.parse(init.body)).toEqual({
        token: 'server-token',
        action: 'ack',
        threadId: 'thread123',
      })
      expect(activity.logActivity).toHaveBeenCalledWith(
        'org-1',
        'planner',
        'ack_nudge',
        'nudge',
        'n1',
        expect.anything()
      )
    })

    it('dismiss and wont_do ack the nudge but never move the card', async () => {
      for (const action of ['dismiss', 'wont_do'] as const) {
        const res = await applyWriteThrough({
          prisma: mockPrisma as never,
          item: emailItem(),
          action,
          session: SESSION,
        })
        expect(res).toEqual([{ kind: 'nudge_acked', ok: true, nudgeId: 'n1' }])
      }
      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
      expect(mockPrisma.nudge.update).toHaveBeenCalledTimes(2)
    })

    it('a non-owner gets not_mailbox_owner: no nudge update, no upstream fetch, no activity for the ack', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ email: 'someone-else@example.com' })
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: emailItem(),
        action: 'dismiss',
        session: SESSION,
      })
      expect(res).toEqual([{ kind: 'nudge_acked', ok: false, error: 'not_mailbox_owner' }])
      expect(mockPrisma.nudge.update).not.toHaveBeenCalled()
      expect(globalThis.fetch).not.toHaveBeenCalled()
      expect(activity.logActivity).not.toHaveBeenCalledWith(
        'org-1',
        'planner',
        'ack_nudge',
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
    })

    it('fails closed when INBOX_AGENT_OWNER is unset', async () => {
      vi.stubEnv('INBOX_AGENT_OWNER', '')
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: emailItem(),
        action: 'dismiss',
        session: SESSION,
      })
      expect(res).toEqual([{ kind: 'nudge_acked', ok: false, error: 'not_mailbox_owner' }])
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('acks the nudge but never relays a malformed Gmail id upstream', async () => {
      mockPrisma.nudge.findFirst.mockResolvedValue({
        id: 'n1',
        orgId: 'org-1',
        status: 'pending',
        gmailThreadId: 'https://evil.example/x',
      })
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: emailItem(),
        action: 'dismiss',
        session: SESSION,
      })
      expect(res).toEqual([{ kind: 'nudge_acked', ok: true, nudgeId: 'n1' }])
      expect(mockPrisma.nudge.update).toHaveBeenCalledTimes(1)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('skips the ack (and the label clear) when the card move failed', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('boom'))
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: emailItem(),
        action: 'done',
        session: SESSION,
      })
      expect(res).toEqual([
        { kind: 'card_moved', ok: false, error: 'boom' },
        { kind: 'nudge_acked', ok: false, error: 'skipped: card move failed' },
      ])
      expect(mockPrisma.nudge.update).not.toHaveBeenCalled()
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('no_done_column and card_missing do not block the ack', async () => {
      mockPrisma.card.findUnique.mockResolvedValue(null)
      mockPrisma.card.findFirst.mockResolvedValue(null)
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: emailItem(),
        action: 'done',
        session: SESSION,
      })
      expect(res).toEqual([
        { kind: 'none', ok: true, reason: 'card_missing' },
        { kind: 'nudge_acked', ok: true, nudgeId: 'n1' },
      ])
    })

    it('an already-acked or missing nudge is reported as acked idempotently, without a fetch', async () => {
      mockPrisma.nudge.findFirst.mockResolvedValue(null)
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: emailItem(),
        action: 'dismiss',
        session: SESSION,
      })
      expect(res).toEqual([{ kind: 'nudge_acked', ok: true, nudgeId: 'n1' }])
      expect(mockPrisma.nudge.update).not.toHaveBeenCalled()
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('an email item without a nudge only moves the card', async () => {
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: emailItem({
          payload: { cardId: 'c1', boardId: 'b1', gmailThreadId: 'thread123', nudgeId: null },
        }),
        action: 'done',
        session: SESSION,
      })
      expect(res).toEqual([
        {
          kind: 'card_moved',
          ok: true,
          cardId: 'c1',
          toColumnId: 'col-done',
          toColumnName: 'Done',
        },
      ])
    })

    it('silently skips the upstream call when the inbox agent is not configured, still acking locally', async () => {
      vi.stubEnv('INBOX_AGENT_URL', '')
      const res = await applyWriteThrough({
        prisma: mockPrisma as never,
        item: emailItem(),
        action: 'dismiss',
        session: SESSION,
      })
      expect(res).toEqual([{ kind: 'nudge_acked', ok: true, nudgeId: 'n1' }])
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  })

  it('reopen and snooze never reverse anything; done on calendar/slack/manual is not applicable', async () => {
    for (const action of ['reopen', 'snooze'] as const) {
      expect(
        await applyWriteThrough({
          prisma: mockPrisma as never,
          item: item(),
          action,
          session: SESSION,
        })
      ).toEqual([{ kind: 'none', ok: true, reason: 'not_applicable' }])
    }
    for (const source of ['calendar', 'slack', 'manual'] as const) {
      expect(
        await applyWriteThrough({
          prisma: mockPrisma as never,
          item: item({ source, sourceKey: `${source}:x`, payload: {} }),
          action: 'done',
          session: SESSION,
        })
      ).toEqual([{ kind: 'none', ok: true, reason: 'not_applicable' }])
    }
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.nudge.update).not.toHaveBeenCalled()
  })
})
