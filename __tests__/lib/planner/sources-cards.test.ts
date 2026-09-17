/**
 * Card source (spec §4.5 cards.ts): the user's assignee / reviewer / approver
 * cards, minus terminal columns and the inbox board. (WI-1)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  card: { findMany: vi.fn() },
}))
vi.mock('../../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

import { readCards } from '../../../src/lib/planner/sources/cards'
import type { SourceContext } from '../../../src/lib/planner/types'
import { dayBounds } from '../../../src/lib/planner/time'

const NOW = new Date('2026-09-16T09:00:00Z')
const CTX: SourceContext = {
  userId: 'user-1',
  orgId: 'org-1',
  tz: 'UTC',
  now: NOW,
  window: dayBounds('2026-09-16', 'UTC'),
}

type Signoff = { role: string; decision: string; createdAt: Date }
function card(over: Record<string, unknown> & { signoffs?: Signoff[] } = {}) {
  return {
    id: 'c1',
    title: 'Ship it',
    boardId: 'b1',
    columnId: 'col-progress',
    priority: 'high',
    dueDate: new Date('2026-09-17T10:00:00Z'),
    assigneeId: 'user-1',
    reviewerId: null,
    approverId: null,
    board: { id: 'b1', name: 'Demo Board' },
    column: { id: 'col-progress', name: 'In Progress' },
    signoffs: [] as Signoff[],
    ...over,
  }
}

describe('planner/sources/cards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('INBOX_BOARD_ID', '')
    mockPrisma.card.findMany.mockResolvedValue([])
  })

  it('queries the org for cards where the user holds any of the three roles', async () => {
    await readCards(CTX)
    const where = mockPrisma.card.findMany.mock.calls[0][0].where
    expect(where.board).toEqual({ orgId: 'org-1' })
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { assigneeId: 'user-1' },
        { reviewerId: 'user-1' },
        { approverId: 'user-1' },
      ])
    )
  })

  it('is always configured: returns a read (never null) with resolveMissing "all"', async () => {
    const read = await readCards(CTX)
    expect(read).not.toBeNull()
    expect(read!.items).toEqual([])
    expect(read!.resolveMissing).toBe('all')
  })

  it('maps an assignee card to a planner item with the app-relative deep link', async () => {
    mockPrisma.card.findMany.mockResolvedValue([card()])
    const read = await readCards(CTX)
    expect(read!.items).toEqual([
      {
        sourceKey: 'card:c1',
        title: 'Ship it',
        summary: 'Demo Board · In Progress',
        url: '/board/b1?card=c1',
        priority: 'high',
        dueAt: new Date('2026-09-17T10:00:00Z'),
        payload: {
          cardId: 'c1',
          boardId: 'b1',
          boardName: 'Demo Board',
          columnId: 'col-progress',
          columnName: 'In Progress',
          role: 'assignee',
        },
      },
    ])
  })

  it('excludes cards in terminal columns (done / closed / shipped / archived, any case)', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      card({ id: 'c1', column: { id: 'x', name: 'Done' } }),
      card({ id: 'c2', column: { id: 'x', name: 'closed' } }),
      card({ id: 'c3', column: { id: 'x', name: 'SHIPPED' } }),
      card({ id: 'c4', column: { id: 'x', name: 'Archived' } }),
      card({ id: 'c5', column: { id: 'x', name: 'Review' } }),
    ])
    const read = await readCards(CTX)
    expect(read!.items.map((i) => i.sourceKey)).toEqual(['card:c5'])
  })

  it('excludes cards on the inbox board (those are email items)', async () => {
    vi.stubEnv('INBOX_BOARD_ID', 'inbox-board')
    mockPrisma.card.findMany.mockResolvedValue([
      card({ id: 'c1', boardId: 'inbox-board', board: { id: 'inbox-board', name: 'Inbox' } }),
      card({ id: 'c2' }),
    ])
    const read = await readCards(CTX)
    expect(read!.items.map((i) => i.sourceKey)).toEqual(['card:c2'])
  })

  it('includes reviewer cards only while the review needs action', async () => {
    const old = new Date('2026-09-10T00:00:00Z')
    const newer = new Date('2026-09-12T00:00:00Z')
    mockPrisma.card.findMany.mockResolvedValue([
      card({ id: 'r1', assigneeId: 'other', reviewerId: 'user-1', signoffs: [] }),
      card({
        id: 'r2',
        assigneeId: 'other',
        reviewerId: 'user-1',
        signoffs: [{ role: 'REVIEWER', decision: 'APPROVED', createdAt: newer }],
      }),
      card({
        id: 'r3',
        assigneeId: 'other',
        reviewerId: 'user-1',
        signoffs: [
          { role: 'REVIEWER', decision: 'REQUESTED_CHANGES', createdAt: newer },
          { role: 'REVIEWER', decision: 'APPROVED', createdAt: old },
        ],
      }),
      card({
        id: 'r4',
        assigneeId: 'other',
        reviewerId: 'user-1',
        // an APPROVER decision does not satisfy the reviewer role
        signoffs: [{ role: 'APPROVER', decision: 'APPROVED', createdAt: newer }],
      }),
    ])
    const read = await readCards(CTX)
    const byKey = Object.fromEntries(read!.items.map((i) => [i.sourceKey, i]))
    expect(Object.keys(byKey).sort()).toEqual(['card:r1', 'card:r3', 'card:r4'])
    expect(byKey['card:r1'].payload.role).toBe('reviewer')
    expect(byKey['card:r3'].payload.role).toBe('reviewer')
  })

  it('includes approver cards with the same rule', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      card({ id: 'a1', assigneeId: 'other', approverId: 'user-1', signoffs: [] }),
      card({
        id: 'a2',
        assigneeId: 'other',
        approverId: 'user-1',
        signoffs: [{ role: 'APPROVER', decision: 'APPROVED', createdAt: new Date() }],
      }),
    ])
    const read = await readCards(CTX)
    expect(read!.items.map((i) => [i.sourceKey, i.payload.role])).toEqual([['card:a1', 'approver']])
  })

  it('role precedence: assignee, then reviewer, then approver', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      card({ id: 'm1', assigneeId: 'user-1', reviewerId: 'user-1', approverId: 'user-1' }),
      card({ id: 'm2', assigneeId: 'other', reviewerId: 'user-1', approverId: 'user-1' }),
    ])
    const read = await readCards(CTX)
    expect(read!.items.map((i) => [i.sourceKey, i.payload.role])).toEqual([
      ['card:m1', 'assignee'],
      ['card:m2', 'reviewer'],
    ])
  })

  it('normalises unknown priorities to none and null due dates', async () => {
    mockPrisma.card.findMany.mockResolvedValue([card({ priority: 'urgent', dueDate: null })])
    const [it1] = (await readCards(CTX))!.items
    expect(it1.priority).toBe('none')
    expect(it1.dueAt).toBeNull()
  })
})
