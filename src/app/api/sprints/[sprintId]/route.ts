import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const updateSprintSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'COMPLETED']).optional(),
})

/**
 * Resolves a sprint, verifying it exists and that its board belongs to
 * the session user's org.
 */
async function resolveSprint(sprintId: string, orgId: string) {
  const sprint = await prisma.sprint.findUnique({
    where: { id: sprintId },
    include: { board: { select: { orgId: true } } },
  })
  if (!sprint) {
    throw NextResponse.json({ error: 'Sprint not found' }, { status: 404 })
  }
  if (sprint.board.orgId !== orgId) {
    throw NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return sprint
}

// GET /api/sprints/[sprintId]
// Returns sprint details.
export async function GET(
  req: NextRequest,
  { params }: { params: { sprintId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')
    const sprint = await resolveSprint(params.sprintId, session.orgId)

    return NextResponse.json({ sprint })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/sprints/[sprintId] error:', err)
    return apiError(500, 'Internal server error')
  }
}

// PATCH /api/sprints/[sprintId]
// Updates sprint name, dates, or status.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { sprintId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')
    await resolveSprint(params.sprintId, session.orgId)

    const body = await req.json()
    const result = updateSprintSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { name, startDate, endDate, status } = result.data
    const updateData: Record<string, unknown> = {}
    if (name !== undefined) updateData.name = name
    if (startDate !== undefined) updateData.startDate = new Date(startDate)
    if (endDate !== undefined) updateData.endDate = new Date(endDate)
    if (status !== undefined) updateData.status = status

    if (Object.keys(updateData).length === 0) {
      return apiError(400, 'No fields provided to update')
    }

    const sprint = await prisma.sprint.update({
      where: { id: params.sprintId },
      data: updateData,
    })

    return NextResponse.json({ sprint })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('PATCH /api/sprints/[sprintId] error:', err)
    return apiError(500, 'Internal server error')
  }
}

// DELETE /api/sprints/[sprintId]
// Deletes the sprint. Cards with this sprintId will have sprintId set to null (no cascade on Card.sprint).
export async function DELETE(
  req: NextRequest,
  { params }: { params: { sprintId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')
    await resolveSprint(params.sprintId, session.orgId)

    // Unlink cards from this sprint before deletion (no cascade on Sprint->Card)
    await prisma.card.updateMany({
      where: { sprintId: params.sprintId },
      data: { sprintId: null },
    })

    await prisma.sprint.delete({ where: { id: params.sprintId } })

    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('DELETE /api/sprints/[sprintId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
