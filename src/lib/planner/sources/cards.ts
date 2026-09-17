// Card source for the Today planner.
// Spec: docs/specs/mhud-today-planner.md §4.5 (cards.ts).
//
// The user's own board work: cards they are the assignee of, plus review and
// approval requests that still need a decision. Terminal columns and the inbox
// board (whose cards are email items) are left out.

import { prisma } from '@/lib/db'
import { PLANNER_PRIORITIES } from '../types'
import type { PlannerPriority, SourceContext, SourceItem, SourceRead } from '../types'

/** Lower-cased column names that mean "finished" (api/hud/[id]/pertinent/route.ts:9). */
const TERMINAL_COLUMNS = new Set(['done', 'closed', 'shipped', 'archived'])

type CardRole = 'assignee' | 'reviewer' | 'approver'

interface SignoffRow {
  role: string
  decision: string
}

interface CardRow {
  id: string
  title: string
  boardId: string
  priority: string
  dueDate: Date | null
  assigneeId: string | null
  reviewerId: string | null
  approverId: string | null
  board: { name: string }
  column: { id: string; name: string }
  signoffs: SignoffRow[]
}

/** Copy of src/app/api/me/assignments/route.ts:47-52 — signoffs are newest first. */
function needsAction(card: { signoffs: SignoffRow[] }, role: 'REVIEWER' | 'APPROVER'): boolean {
  const latest = card.signoffs.find((s) => s.role === role)
  return !latest || latest.decision === 'REQUESTED_CHANGES'
}

/** The first role of assignee → reviewer → approver that applies to this user. */
function roleFor(card: CardRow, userId: string): CardRole | null {
  if (card.assigneeId === userId) return 'assignee'
  if (card.reviewerId === userId && needsAction(card, 'REVIEWER')) return 'reviewer'
  if (card.approverId === userId && needsAction(card, 'APPROVER')) return 'approver'
  return null
}

function asPriority(value: string | null | undefined): PlannerPriority {
  return value && (PLANNER_PRIORITIES as readonly string[]).includes(value)
    ? (value as PlannerPriority)
    : 'none'
}

/** Always configured — this source never returns null. */
export async function readCards(ctx: SourceContext): Promise<SourceRead> {
  const inboxBoardId = process.env.INBOX_BOARD_ID
  const cards: CardRow[] = await prisma.card.findMany({
    where: {
      board: { orgId: ctx.orgId },
      OR: [{ assigneeId: ctx.userId }, { reviewerId: ctx.userId }, { approverId: ctx.userId }],
    },
    include: {
      board: { select: { id: true, name: true } },
      column: { select: { id: true, name: true } },
      signoffs: { orderBy: { createdAt: 'desc' } },
    },
  })

  const items: SourceItem[] = []
  for (const card of cards) {
    if (inboxBoardId && card.boardId === inboxBoardId) continue
    const columnName = card.column?.name ?? ''
    if (TERMINAL_COLUMNS.has(columnName.toLowerCase())) continue
    const role = roleFor(card, ctx.userId)
    if (!role) continue

    items.push({
      sourceKey: `card:${card.id}`,
      title: card.title,
      summary: `${card.board.name} · ${columnName}`,
      url: `/board/${card.boardId}?card=${card.id}`,
      priority: asPriority(card.priority),
      dueAt: card.dueDate ?? null,
      payload: {
        cardId: card.id,
        boardId: card.boardId,
        boardName: card.board.name,
        columnId: card.column.id,
        columnName,
        role,
      },
    })
  }

  // A card that left the board (or the query) is a fact, not a gap in a
  // lookback window: absence resolves open and snoozed rows alike.
  return { items, resolveMissing: 'all' }
}
