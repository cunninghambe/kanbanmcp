// The board handoffs (spec §4.11): a comment on an existing card, or a new card
// from the draft. Every id that arrives in the request body is checked against
// the caller's org before it is written — cards and boards through `board.orgId`,
// `assigneeId` through `roleMembershipCheck`.

import type { PrismaClient } from '@prisma/client'
import { roleMembershipCheck } from '@/lib/cards'

export class CardNotFoundError extends Error {
  readonly code = 'CARD_NOT_FOUND' as const
  constructor(message = 'Card not found') {
    super(message)
    this.name = 'CardNotFoundError'
  }
}

export class BoardNotFoundError extends Error {
  readonly code = 'BOARD_NOT_FOUND' as const
  constructor(message = 'Board not found') {
    super(message)
    this.name = 'BoardNotFoundError'
  }
}

export class ColumnNotOnBoardError extends Error {
  readonly code = 'COLUMN_NOT_ON_BOARD' as const
  constructor(message = 'Column does not belong to this board') {
    super(message)
    this.name = 'ColumnNotOnBoardError'
  }
}

export class AssigneeNotMemberError extends Error {
  readonly code = 'ASSIGNEE_NOT_MEMBER' as const
  constructor(message = 'assigneeId must be a member of this organization') {
    super(message)
    this.name = 'AssigneeNotMemberError'
  }
}

export async function handoffCardComment(args: {
  prisma: PrismaClient
  orgId: string
  userId: string
  cardId: string
  content: string
}): Promise<{ commentId: string; cardId: string; boardId: string }> {
  const { prisma, orgId, userId, cardId, content } = args

  const card = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId } },
    select: { id: true, boardId: true },
  })
  if (!card) throw new CardNotFoundError()

  const comment = await prisma.comment.create({
    data: { cardId: card.id, userId, content },
    select: { id: true },
  })
  return { commentId: comment.id, cardId: card.id, boardId: card.boardId }
}

export async function handoffCardCreate(args: {
  prisma: PrismaClient
  orgId: string
  userId: string
  boardId: string
  columnId?: string
  title: string
  description: string
  assigneeId?: string
}): Promise<{ cardId: string; boardId: string; columnId: string }> {
  const { prisma, orgId, userId, boardId, title, description } = args

  const board = await prisma.board.findFirst({
    where: { id: boardId, orgId },
    select: {
      id: true,
      columns: { select: { id: true }, orderBy: { position: 'asc' }, take: 1 },
    },
  })
  if (!board) throw new BoardNotFoundError()

  let columnId = args.columnId
  if (columnId) {
    const column = await prisma.column.findFirst({
      where: { id: columnId, boardId: board.id },
      select: { id: true },
    })
    if (!column) throw new ColumnNotOnBoardError()
  } else {
    columnId = board.columns[0]?.id
    if (!columnId) throw new ColumnNotOnBoardError('This board has no columns')
  }

  const assigneeId = args.assigneeId ?? userId
  if (args.assigneeId) {
    const check = await roleMembershipCheck(prisma, [args.assigneeId], orgId)
    if (!check.ok) throw new AssigneeNotMemberError()
  }

  const last = await prisma.card.findFirst({
    where: { columnId },
    orderBy: { position: 'desc' },
    select: { position: true },
  })

  const card = await prisma.card.create({
    data: {
      title,
      description,
      boardId: board.id,
      columnId,
      assigneeId,
      createdById: userId,
      position: last ? last.position + 1 : 0,
      path: '',
      depth: 0,
    },
    select: { id: true },
  })
  return { cardId: card.id, boardId: board.id, columnId }
}
