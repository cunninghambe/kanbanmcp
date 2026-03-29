import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const createLabelSchema = z.object({
  name: z.string().min(1, 'Label name is required').max(100),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex color (e.g. #ff0000)'),
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

// GET /api/boards/[boardId]/labels
// Returns all labels for the given board.
export async function GET(
  req: NextRequest,
  { params }: { params: { boardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveBoard(params.boardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const labels = await prisma.label.findMany({
      where: { boardId: params.boardId },
      orderBy: { name: 'asc' },
    })

    return NextResponse.json({ labels })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/boards/[boardId]/labels error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/boards/[boardId]/labels
// Creates a new label for the given board.
export async function POST(
  req: NextRequest,
  { params }: { params: { boardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveBoard(params.boardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = createLabelSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const label = await prisma.label.create({
      data: {
        name: result.data.name,
        color: result.data.color,
        boardId: params.boardId,
      },
    })

    return NextResponse.json({ label }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/boards/[boardId]/labels error:', err)
    return apiError(500, 'Internal server error')
  }
}
