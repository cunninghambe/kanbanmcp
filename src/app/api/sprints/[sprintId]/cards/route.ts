import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const assignCardSchema = z.object({
  cardId: z.string().min(1, 'Card ID is required'),
})

/**
 * Resolves a sprint, verifying it exists and its board belongs to
 * the session user's org.
 */
async function resolveSprint(sprintId: string, orgId: string) {
  const sprint = await prisma.sprint.findUnique({
    where: { id: sprintId },
    include: { board: { select: { orgId: true, id: true } } },
  })
  if (!sprint) {
    throw NextResponse.json({ error: 'Sprint not found' }, { status: 404 })
  }
  if (sprint.board.orgId !== orgId) {
    throw NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return sprint
}

// GET /api/sprints/[sprintId]/cards
// Returns all cards assigned to this sprint (across all columns).
export async function GET(
  req: NextRequest,
  { params }: { params: { sprintId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')
    await resolveSprint(params.sprintId, session.orgId)

    const cards = await prisma.card.findMany({
      where: { sprintId: params.sprintId },
      orderBy: [{ columnId: 'asc' }, { position: 'asc' }],
      include: {
        labels: { include: { label: true } },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        },
        assignee: { select: { id: true, email: true, name: true } },
        column: { select: { id: true, name: true } },
      },
    })

    return NextResponse.json({ cards })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/sprints/[sprintId]/cards error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/sprints/[sprintId]/cards
// Assigns a card to this sprint by setting card.sprintId = sprintId.
// The card must belong to the same board as the sprint.
export async function POST(
  req: NextRequest,
  { params }: { params: { sprintId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')
    const sprint = await resolveSprint(params.sprintId, session.orgId)

    const body = await req.json()
    const result = assignCardSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { cardId } = result.data

    // Verify the card exists and belongs to the same board as the sprint
    const card = await prisma.card.findUnique({ where: { id: cardId } })
    if (!card) {
      return apiError(404, 'Card not found')
    }
    if (card.boardId !== sprint.board.id) {
      return apiError(400, 'Card does not belong to the same board as this sprint')
    }

    const updatedCard = await prisma.card.update({
      where: { id: cardId },
      data: { sprintId: params.sprintId },
      include: {
        labels: { include: { label: true } },
        assignee: { select: { id: true, email: true, name: true } },
        column: { select: { id: true, name: true } },
        sprint: { select: { id: true, name: true, status: true } },
      },
    })

    return NextResponse.json({ card: updatedCard })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/sprints/[sprintId]/cards error:', err)
    return apiError(500, 'Internal server error')
  }
}
