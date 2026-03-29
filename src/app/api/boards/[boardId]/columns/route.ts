import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const createColumnSchema = z.object({
  name: z.string().min(1, 'Column name is required').max(255),
  position: z.number().int().min(0).optional(),
})

const reorderColumnsSchema = z.object({
  columns: z
    .array(
      z.object({
        id: z.string().min(1),
        position: z.number().int().min(0),
      })
    )
    .min(1),
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

// POST /api/boards/[boardId]/columns
// Creates a new column. If position is not supplied, appends after the last column.
export async function POST(
  req: NextRequest,
  { params }: { params: { boardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveBoard(params.boardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = createColumnSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    let position = result.data.position
    if (position === undefined) {
      // Append to the end
      const last = await prisma.column.findFirst({
        where: { boardId: params.boardId },
        orderBy: { position: 'desc' },
        select: { position: true },
      })
      position = last ? last.position + 1 : 0
    }

    const column = await prisma.column.create({
      data: {
        name: result.data.name,
        position,
        boardId: params.boardId,
      },
    })

    return NextResponse.json({ column }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/boards/[boardId]/columns error:', err)
    return apiError(500, 'Internal server error')
  }
}

// PATCH /api/boards/[boardId]/columns
// Reorders columns by accepting an array of { id, position } pairs.
// All supplied column ids must belong to the board.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { boardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveBoard(params.boardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = reorderColumnsSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { columns } = result.data

    // Verify all columns belong to this board
    const columnIds = columns.map((c) => c.id)
    const existingColumns = await prisma.column.findMany({
      where: { id: { in: columnIds }, boardId: params.boardId },
      select: { id: true },
    })

    if (existingColumns.length !== columnIds.length) {
      return apiError(400, 'One or more column IDs do not belong to this board')
    }

    // Bulk update positions in a transaction
    await prisma.$transaction(
      columns.map((col) =>
        prisma.column.update({
          where: { id: col.id },
          data: { position: col.position },
        })
      )
    )

    const updatedColumns = await prisma.column.findMany({
      where: { boardId: params.boardId },
      orderBy: { position: 'asc' },
    })

    return NextResponse.json({ columns: updatedColumns })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('PATCH /api/boards/[boardId]/columns error:', err)
    return apiError(500, 'Internal server error')
  }
}
