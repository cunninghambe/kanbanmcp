import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import {
  aiReviewParamsSchema,
  computeChildPathAndDepth,
  roleMembershipCheck,
  decodeAiReviewParams,
  MAX_NESTING_DEPTH,
} from '@/lib/cards'

const createCardSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  columnId: z.string().min(1, 'Column ID is required'),
  description: z.string().optional(),
  sprintId: z.string().optional(),
  assigneeId: z.string().min(1), // NOW REQUIRED — AC-4
  reviewerId: z.string().min(1).optional(),
  approverId: z.string().min(1).optional(),
  parentCardId: z.string().min(1).optional(),
  aiAutoReview: z.boolean().optional(),
  aiReviewParams: aiReviewParamsSchema.nullable().optional(),
  dueDate: z.string().datetime({ offset: true }).optional(),
  labels: z.array(z.string()).optional(),
})

/**
 * Verifies the board exists and belongs to the session user's org.
 */
async function resolveBoard(boardId: string, orgId: string) {
  const board = await prisma.board.findUnique({ where: { id: boardId } })
  if (!board) {
    throw NextResponse.json({ error: 'Board not found' }, { status: 404 })
  }
  if (board.orgId !== orgId) {
    throw NextResponse.json({ error: 'Board not found' }, { status: 404 })
  }
  return board
}

// POST /api/boards/[boardId]/cards
// Creates a card in the specified column. Position = max existing + 1 (or 0 if empty column).
export async function POST(req: NextRequest, { params }: { params: { boardId: string } }) {
  try {
    const session = await requireSession(req)
    await resolveBoard(params.boardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = createCardSchema.safeParse(body)
    if (!result.success) {
      const hasAssigneeIssue = result.error.issues.some((i) => i.path[0] === 'assigneeId')
      if (hasAssigneeIssue) {
        return apiError(400, 'assigneeId is required')
      }
      return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
    }

    const {
      title,
      columnId,
      description,
      sprintId,
      assigneeId,
      reviewerId,
      approverId,
      parentCardId,
      aiAutoReview,
      aiReviewParams,
      dueDate,
      labels,
    } = result.data

    // Verify the column belongs to this board
    const column = await prisma.column.findUnique({ where: { id: columnId } })
    if (!column || column.boardId !== params.boardId) {
      return apiError(400, 'Column does not belong to this board')
    }

    // Validate all role user IDs are org members (IDOR protection)
    const roleIdEntries: Array<[string, string]> = [['assigneeId', assigneeId]]
    if (reviewerId !== undefined) roleIdEntries.push(['reviewerId', reviewerId])
    if (approverId !== undefined) roleIdEntries.push(['approverId', approverId])

    const memberCheck = await roleMembershipCheck(
      prisma,
      roleIdEntries.map(([, id]) => id),
      session.orgId
    )
    if (!memberCheck.ok) {
      const [role] = roleIdEntries.find(([, id]) => id === memberCheck.missingId) ?? ['assigneeId']
      return apiError(400, `${role} must be a member of this organization`)
    }

    // For API key auth, Card.createdById is required (non-nullable). Use the first
    // org admin as the creator and set agentId to track the actual agent.
    let createdById = session.userId
    let agentId: string | null = null
    if (session.isApiKeyAuth) {
      const orgMember = await prisma.orgMember.findFirst({
        where: { orgId: session.orgId },
        orderBy: { role: 'desc' }, // ADMIN > MEMBER alphabetically desc
        select: { userId: true },
      })
      if (!orgMember) {
        return apiError(500, 'No org member found to associate card with')
      }
      createdById = orgMember.userId
      agentId = session.agentName ?? null
    }

    // Wrap the depth re-check and insert in a single transaction to close the
    // read-check-insert race: two concurrent requests at depth 49 could both
    // pass the check and produce two depth-50 children without this guard.
    const card = await prisma.$transaction(async (tx) => {
      let path = ''
      let depth = 0
      if (parentCardId !== undefined) {
        const parentCard = await tx.card.findUnique({
          where: { id: parentCardId },
          select: { id: true, boardId: true, path: true, depth: true },
        })
        if (!parentCard) {
          throw NextResponse.json({ error: 'Parent card not found' }, { status: 400 })
        }
        if (parentCard.boardId !== params.boardId) {
          throw NextResponse.json({ error: 'Parent card must be on the same board' }, { status: 400 })
        }
        // parent at depth 49 -> child would be depth 50 = MAX_NESTING_DEPTH -> reject
        if (parentCard.depth + 1 >= MAX_NESTING_DEPTH) {
          throw NextResponse.json({ error: 'Maximum nesting depth (50) reached' }, { status: 400 })
        }
        const computed = computeChildPathAndDepth(parentCard)
        path = computed.path
        depth = computed.depth
      }

      // Determine position: max existing position in the column + 1
      const maxPositionRecord = await tx.card.findFirst({
        where: { columnId },
        orderBy: { position: 'desc' },
        select: { position: true },
      })
      const position = maxPositionRecord ? maxPositionRecord.position + 1 : 0

      return tx.card.create({
        data: {
          title,
          description,
          columnId,
          boardId: params.boardId,
          sprintId: sprintId ?? null,
          assigneeId,
          reviewerId: reviewerId ?? null,
          approverId: approverId ?? null,
          parentCardId: parentCardId ?? null,
          path,
          depth,
          aiAutoReview: aiAutoReview ?? false,
          aiReviewParams: aiReviewParams ? JSON.stringify(aiReviewParams) : null,
          position,
          dueDate: dueDate ? new Date(dueDate) : null,
          createdById,
          agentId,
          ...(labels && labels.length > 0
            ? {
                labels: {
                  create: labels.map((labelId) => ({ labelId })),
                },
              }
            : {}),
        },
        include: {
          labels: { include: { label: true } },
          assignee: { select: { id: true, email: true, name: true } },
          reviewer: { select: { id: true, email: true, name: true } },
          approver: { select: { id: true, email: true, name: true } },
          createdBy: { select: { id: true, email: true, name: true } },
        },
      })
    })

    return NextResponse.json(
      {
        card: {
          ...card,
          aiReviewParams: decodeAiReviewParams(card.aiReviewParams),
        },
      },
      { status: 201 }
    )
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/boards/[boardId]/cards error:', err)
    return apiError(500, 'Internal server error')
  }
}
