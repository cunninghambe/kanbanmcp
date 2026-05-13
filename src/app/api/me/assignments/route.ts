import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'

export type AssignmentCard = {
  id: string
  title: string
  boardId: string
  boardName: string
  columnName: string
  priority: string
  dueDate: string | null
  hasOpenReviews: boolean
}

type AssignmentsResponse = {
  asAssignee: AssignmentCard[]
  asReviewer: AssignmentCard[]
  asApprover: AssignmentCard[]
  overdue: AssignmentCard[]
}

function toCard(card: {
  id: string
  title: string
  boardId: string
  priority: string
  dueDate: Date | null
  board: { name: string }
  column: { name: string }
  signoffs: { role: string; decision: string; createdAt: Date }[]
}): AssignmentCard {
  return {
    id: card.id,
    title: card.title,
    boardId: card.boardId,
    boardName: card.board.name,
    columnName: card.column.name,
    priority: card.priority,
    dueDate: card.dueDate?.toISOString() ?? null,
    hasOpenReviews: card.signoffs.some(
      (s) => s.decision === 'REQUESTED_CHANGES'
    ),
  }
}

function needsAction(
  card: { signoffs: { role: string; decision: string }[] },
  role: 'REVIEWER' | 'APPROVER'
): boolean {
  // signoffs are ordered desc from the query — first match is the latest
  const latest = card.signoffs.find((s) => s.role === role)
  return !latest || latest.decision === 'REQUESTED_CHANGES'
}

const CARD_INCLUDE = {
  board: { select: { name: true, orgId: true } },
  column: { select: { name: true } },
  signoffs: {
    orderBy: { createdAt: 'desc' as const },
  },
}

// GET /api/me/assignments
// Returns cards needing the current user's attention, scoped to their org.
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession(req)
    const now = new Date()

    const [assigneeCards, reviewerCards, approverCards] = await Promise.all([
      prisma.card.findMany({
        where: {
          assigneeId: session.userId,
          board: { orgId: session.orgId },
          column: { NOT: { name: 'Done' } },
        },
        include: CARD_INCLUDE,
      }),
      prisma.card.findMany({
        where: {
          reviewerId: session.userId,
          board: { orgId: session.orgId },
          column: { NOT: { name: 'Done' } },
        },
        include: CARD_INCLUDE,
      }),
      prisma.card.findMany({
        where: {
          approverId: session.userId,
          board: { orgId: session.orgId },
          column: { NOT: { name: 'Done' } },
        },
        include: CARD_INCLUDE,
      }),
    ])

    const asAssigneeAll = assigneeCards.map(toCard)
    const overdue = asAssigneeAll.filter(
      (c) => c.dueDate !== null && new Date(c.dueDate) < now
    )
    const asAssignee = asAssigneeAll.filter(
      (c) => c.dueDate === null || new Date(c.dueDate) >= now
    )

    const asReviewer = reviewerCards
      .filter((c) => needsAction(c, 'REVIEWER'))
      .map(toCard)

    const asApprover = approverCards
      .filter((c) => needsAction(c, 'APPROVER'))
      .map(toCard)

    const response: AssignmentsResponse = { asAssignee, asReviewer, asApprover, overdue }
    return NextResponse.json(response)
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/me/assignments error:', err)
    return apiError(500, 'Internal server error')
  }
}
