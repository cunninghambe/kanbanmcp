import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'critical'] as const

const updateCardSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  columnId: z.string().optional(),
  position: z.number().int().min(0).optional(),
  sprintId: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(VALID_PRIORITIES).optional(),
  labels: z.array(z.string()).optional(),
  siblingPositions: z
    .array(
      z.object({
        id: z.string(),
        position: z.number().int().min(0),
      })
    )
    .optional(),
})

/**
 * Resolves a card, verifying it exists and that its board belongs to the
 * session user's org. Returns the card.
 */
async function resolveCard(cardId: string, orgId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { board: { select: { orgId: true } } },
  })
  if (!card) {
    throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }
  if (card.board.orgId !== orgId) {
    throw NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return card
}

// GET /api/cards/[cardId]
// Returns card with labels, comments, and assignee details.
export async function GET(
  req: NextRequest,
  { params }: { params: { cardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const card = await prisma.card.findUnique({
      where: { id: params.cardId },
      include: {
        labels: { include: { label: true } },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        },
        assignee: { select: { id: true, email: true, name: true } },
        createdBy: { select: { id: true, email: true, name: true } },
        column: { select: { id: true, name: true } },
        sprint: { select: { id: true, name: true, status: true } },
      },
    })

    if (!card) {
      return apiError(404, 'Card not found')
    }

    return NextResponse.json({ card })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/cards/[cardId] error:', err)
    return apiError(500, 'Internal server error')
  }
}

// PATCH /api/cards/[cardId]
// Updates card fields. Handles column moves and bulk position updates.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { cardId: string } }
) {
  try {
    const session = await requireSession(req)
    const existingCard = await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = updateCardSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const {
      title,
      description,
      columnId,
      position,
      sprintId,
      assigneeId,
      dueDate,
      priority,
      labels,
      siblingPositions,
    } = result.data

    // Determine new position when moving to a different column
    let resolvedPosition: number | undefined = position
    const isChangingColumn =
      columnId !== undefined && columnId !== existingCard.columnId

    if (isChangingColumn && siblingPositions === undefined) {
      // Append to end of target column
      const maxRecord = await prisma.card.findFirst({
        where: { columnId: columnId! },
        orderBy: { position: 'desc' },
        select: { position: true },
      })
      resolvedPosition = maxRecord ? maxRecord.position + 1 : 0
    }

    // When changing column WITH siblingPositions, the caller must supply position
    // for the moved card. If they didn't, fall back to append-to-end.
    if (isChangingColumn && siblingPositions !== undefined && resolvedPosition === undefined) {
      const maxRecord = await prisma.card.findFirst({
        where: { columnId: columnId! },
        orderBy: { position: 'desc' },
        select: { position: true },
      })
      resolvedPosition = maxRecord ? maxRecord.position + 1 : 0
    }

    // Validate that any sibling card IDs belong to the same board (security check)
    if (siblingPositions && siblingPositions.length > 0) {
      const siblingIds = siblingPositions.map((s) => s.id)
      const validSiblings = await prisma.card.findMany({
        where: { id: { in: siblingIds }, boardId: existingCard.boardId },
        select: { id: true },
      })
      if (validSiblings.length !== siblingIds.length) {
        return NextResponse.json(
          { error: 'One or more sibling card IDs do not belong to this board' },
          { status: 400 }
        )
      }
    }

    // Validate assigneeId is a member of this org (prevent IDOR cross-org assignment)
    if (assigneeId !== undefined && assigneeId !== null) {
      const assigneeMembership = await prisma.orgMember.findUnique({
        where: { userId_orgId: { userId: assigneeId, orgId: session.orgId } },
      })
      if (!assigneeMembership) {
        return NextResponse.json(
          { error: 'Assignee must be a member of this organization' },
          { status: 400 }
        )
      }
    }

    await prisma.$transaction(async (tx) => {
      // Bulk-update sibling positions if provided
      if (siblingPositions && siblingPositions.length > 0) {
        for (const sibling of siblingPositions) {
          await tx.card.update({
            where: { id: sibling.id },
            data: { position: sibling.position },
          })
        }
      }

      // Replace labels if provided
      if (labels !== undefined) {
        await tx.cardLabel.deleteMany({ where: { cardId: params.cardId } })
        if (labels.length > 0) {
          await tx.cardLabel.createMany({
            data: labels.map((labelId) => ({ cardId: params.cardId, labelId })),
          })
        }
      }

      // Build scalar update payload
      const updateData: Record<string, unknown> = {}
      if (title !== undefined) updateData.title = title
      if (description !== undefined) updateData.description = description
      if (columnId !== undefined) updateData.columnId = columnId
      if (resolvedPosition !== undefined) updateData.position = resolvedPosition
      if (sprintId !== undefined) updateData.sprintId = sprintId
      if (assigneeId !== undefined) updateData.assigneeId = assigneeId
      if (dueDate !== undefined)
        updateData.dueDate = dueDate ? new Date(dueDate) : null
      if (priority !== undefined) updateData.priority = priority

      if (Object.keys(updateData).length > 0) {
        await tx.card.update({
          where: { id: params.cardId },
          data: updateData,
        })
      }
    })

    const card = await prisma.card.findUnique({
      where: { id: params.cardId },
      include: {
        labels: { include: { label: true } },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        },
        assignee: { select: { id: true, email: true, name: true } },
        createdBy: { select: { id: true, email: true, name: true } },
        column: { select: { id: true, name: true } },
        sprint: { select: { id: true, name: true, status: true } },
      },
    })

    return NextResponse.json({ card })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('PATCH /api/cards/[cardId] error:', err)
    return apiError(500, 'Internal server error')
  }
}

// DELETE /api/cards/[cardId]
// Deletes the card. Cascades handle comments and label associations.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { cardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    await prisma.card.delete({ where: { id: params.cardId } })

    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('DELETE /api/cards/[cardId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
