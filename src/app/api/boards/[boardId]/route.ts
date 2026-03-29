import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const updateBoardSchema = z.object({
  name: z.string().min(1, 'Board name is required').max(255),
})

/**
 * Resolve the board and verify it belongs to the session user's org.
 * Returns the board or throws an appropriate error response.
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

// GET /api/boards/[boardId]
// Returns the full board with columns and cards ordered by position ASC.
export async function GET(
  req: NextRequest,
  { params }: { params: { boardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveBoard(params.boardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const board = await prisma.board.findUnique({
      where: { id: params.boardId },
      include: {
        columns: {
          orderBy: { position: 'asc' },
          include: {
            cards: {
              orderBy: { position: 'asc' },
              include: {
                labels: {
                  include: { label: true },
                },
                assignee: {
                  select: { id: true, email: true, name: true },
                },
              },
            },
          },
        },
      },
    })

    if (!board) {
      return apiError(404, 'Board not found')
    }

    return NextResponse.json({ board })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/boards/[boardId] error:', err)
    return apiError(500, 'Internal server error')
  }
}

// PATCH /api/boards/[boardId]
// Updates the board name. Requires MEMBER role.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { boardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveBoard(params.boardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = updateBoardSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const board = await prisma.board.update({
      where: { id: params.boardId },
      data: { name: result.data.name },
    })

    return NextResponse.json({ board })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('PATCH /api/boards/[boardId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
