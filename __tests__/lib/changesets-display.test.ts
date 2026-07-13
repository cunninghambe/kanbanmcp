/**
 * Tests for src/lib/changesets-display.ts — describeChangeItems, the pure
 * (aside from its own batched reads) human-readable renderer for ChangeItem
 * op payloads. See docs/specs/2026-07-13-hud-meeting-manager.md §3.4.
 */
import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

function mockDb(overrides: {
  cards?: Array<{ id: string; title: string; columnId: string }>
  columns?: Array<{ id: string; name: string }>
  boards?: Array<{ id: string; name: string }>
}) {
  return {
    card: { findMany: vi.fn().mockResolvedValue(overrides.cards ?? []) },
    column: { findMany: vi.fn().mockResolvedValue(overrides.columns ?? []) },
    board: { findMany: vi.fn().mockResolvedValue(overrides.boards ?? []) },
  } as unknown as PrismaClient
}

function item(op: string, payload: unknown, opts: { id?: string; targetCardId?: string | null } = {}) {
  return {
    id: opts.id ?? 'item-1',
    op,
    payload: JSON.stringify(payload),
    targetCardId: opts.targetCardId ?? null,
  }
}

describe('describeChangeItems', () => {
  it('POSITIVE: create_card renders "Create card ... in ... on ..."', async () => {
    const db = mockDb({
      columns: [{ id: 'col-1', name: 'To Do' }],
      boards: [{ id: 'board-1', name: 'Roadmap' }],
    })
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const [result] = await describeChangeItems(db, [
      item('create_card', { boardId: 'board-1', columnId: 'col-1', title: 'Ship the deck' }),
    ])
    expect(result.display).toBe('Create card "Ship the deck" in To Do on Roadmap')
  })

  it('POSITIVE: move_card renders "Move ... from ... to ..." using the card\'s current column', async () => {
    const db = mockDb({
      cards: [{ id: 'card-1', title: 'Fix login bug', columnId: 'col-progress' }],
      columns: [
        { id: 'col-progress', name: 'In Progress' },
        { id: 'col-done', name: 'Done' },
      ],
    })
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const [result] = await describeChangeItems(db, [
      item('move_card', { cardId: 'card-1', columnId: 'col-done', position: 1 }),
    ])
    expect(result.display).toBe('Move "Fix login bug" from In Progress to Done')
  })

  it('POSITIVE: update_card renders comma-joined field:value pairs with dueDate labeled "due" and shortened', async () => {
    const db = mockDb({ cards: [{ id: 'card-1', title: 'Budget review', columnId: 'col-1' }] })
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const [result] = await describeChangeItems(db, [
      item('update_card', { cardId: 'card-1', priority: 'high', dueDate: '2026-07-20T00:00:00.000Z' }),
    ])
    expect(result.display).toBe('Update "Budget review": priority: high, due: 2026-07-20')
  })

  it('POSITIVE: comment_card renders content verbatim with no ellipsis when <= 80 chars', async () => {
    const db = mockDb({ cards: [{ id: 'card-1', title: 'Onboarding', columnId: 'col-1' }] })
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const [result] = await describeChangeItems(db, [
      item('comment_card', { cardId: 'card-1', content: 'Looks good to me' }),
    ])
    expect(result.display).toBe('Comment on "Onboarding": "Looks good to me"')
  })

  it('EDGE: comment_card truncates content over 80 chars and appends an ellipsis', async () => {
    const db = mockDb({ cards: [{ id: 'card-1', title: 'Onboarding', columnId: 'col-1' }] })
    const longContent = 'x'.repeat(90)
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const [result] = await describeChangeItems(db, [item('comment_card', { cardId: 'card-1', content: longContent })])
    expect(result.display).toBe(`Comment on "Onboarding": "${'x'.repeat(80)}…"`)
  })

  it('EDGE: a deleted/missing card degrades to the raw id + " (not found)"', async () => {
    const db = mockDb({ cards: [] })
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const [result] = await describeChangeItems(db, [
      item('update_card', { cardId: 'card-gone', priority: 'low' }),
    ])
    expect(result.display).toBe('Update "card-gone (not found)": priority: low')
  })

  it('EDGE: a missing column/board on create_card degrades each independently', async () => {
    const db = mockDb({ columns: [], boards: [] })
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const [result] = await describeChangeItems(db, [
      item('create_card', { boardId: 'board-gone', columnId: 'col-gone', title: 'New task' }),
    ])
    expect(result.display).toBe('Create card "New task" in col-gone (not found) on board-gone (not found)')
  })

  it('EDGE: targetCardId overrides the payload cardId for resolution', async () => {
    const db = mockDb({ cards: [{ id: 'card-retargeted', title: 'Correct card', columnId: 'col-1' }] })
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const [result] = await describeChangeItems(db, [
      item(
        'comment_card',
        { cardId: 'card-original-guess', content: 'hi' },
        { targetCardId: 'card-retargeted' }
      ),
    ])
    expect(result.display).toBe('Comment on "Correct card": "hi"')
  })

  it('NEGATIVE (degradation): malformed payload JSON never throws, renders "«op» (unreadable payload)"', async () => {
    const db = mockDb({})
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const items = [{ id: 'item-1', op: 'move_card', payload: '{not valid json', targetCardId: null }]
    const [result] = await describeChangeItems(db, items)
    expect(result.display).toBe('move_card (unreadable payload)')
  })

  it('NEGATIVE (degradation): a payload that is valid JSON but fails its op schema also degrades to unreadable', async () => {
    const db = mockDb({})
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const [result] = await describeChangeItems(db, [item('create_card', { title: 'missing required fields' })])
    expect(result.display).toBe('create_card (unreadable payload)')
  })

  it('BATCHING: one card/column/board findMany call regardless of item count, and returns in item order', async () => {
    const db = mockDb({
      cards: [
        { id: 'card-1', title: 'Card One', columnId: 'col-a' },
        { id: 'card-2', title: 'Card Two', columnId: 'col-b' },
      ],
      columns: [
        { id: 'col-a', name: 'Col A' },
        { id: 'col-b', name: 'Col B' },
        { id: 'col-c', name: 'Col C' },
      ],
      boards: [{ id: 'board-1', name: 'Board One' }],
    })
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const results = await describeChangeItems(db, [
      item('move_card', { cardId: 'card-1', columnId: 'col-c', position: 1 }, { id: 'item-1' }),
      item('update_card', { cardId: 'card-2', title: 'Renamed' }, { id: 'item-2' }),
      item('create_card', { boardId: 'board-1', columnId: 'col-b', title: 'New' }, { id: 'item-3' }),
      item('comment_card', { cardId: 'card-1', content: 'note' }, { id: 'item-4' }),
    ])

    expect(db.card.findMany).toHaveBeenCalledTimes(1)
    expect(db.column.findMany).toHaveBeenCalledTimes(1)
    expect(db.board.findMany).toHaveBeenCalledTimes(1)
    expect(results.map((r) => r.itemId)).toEqual(['item-1', 'item-2', 'item-3', 'item-4'])
    expect(results[0].display).toBe('Move "Card One" from Col A to Col C')
    expect(results[3].display).toBe('Comment on "Card One": "note"')
  })

  it('DEGRADATION: an empty items array resolves with no lookups and returns an empty list', async () => {
    const db = mockDb({})
    const { describeChangeItems } = await import('../../src/lib/changesets-display')
    const results = await describeChangeItems(db, [])
    expect(results).toEqual([])
    expect(db.card.findMany).not.toHaveBeenCalled()
    expect(db.column.findMany).not.toHaveBeenCalled()
    expect(db.board.findMany).not.toHaveBeenCalled()
  })
})
