import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const createCardSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  columnId: z.string().min(1, 'Column ID is required'),
  description: z.string().optional(),
  sprintId: z.string().optional(),
  assigneeId: z.string().optional(),
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
    throw NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return board
}

// POST /api/boards/[boardId]/cards
// Creates a card in the specified column. Position = max existing + 1 (or 0 if empty column).
export async function POST(
  req: NextRequest,
  { params }: { params: { boardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveBoard(params.boardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = createCardSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { title, columnId, description, sprintId, assigneeId, dueDate, labels } =
      result.data

    // Verify the column belongs to this board
    const column = await prisma.column.findUnique({ where: { id: columnId } })
    if (!column || column.boardId !== params.boardId) {
      return apiError(400, 'Column does not belong to this board')
    }

    // Determine position: max existing position in the column + 1
    const maxPositionRecord = await prisma.card.findFirst({
      where: { columnId },
      orderBy: { position: 'desc' },
      select: { position: true },
    })
    const position = maxPositionRecord ? maxPositionRecord.position + 1 : 0

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

    const card = await prisma.card.create({
      data: {
        title,
        description,
        columnId,
        boardId: params.boardId,
        sprintId: sprintId ?? null,
        assigneeId: assigneeId ?? null,
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
        createdBy: { select: { id: true, email: true, name: true } },
      },
    })

    return NextResponse.json({ card }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/boards/[boardId]/cards error:', err)
    return apiError(500, 'Internal server error')
  }
}
