import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const createSprintSchema = z.object({
  name: z.string().min(1, 'Sprint name is required').max(255),
  boardId: z.string().min(1, 'Board ID is required'),
  startDate: z.string().datetime({ offset: true }),
  endDate: z.string().datetime({ offset: true }),
})

/**
 * Verifies a board exists and belongs to the session user's org.
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

// GET /api/sprints?boardId=xxx
// Returns sprints for the given board.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const { searchParams } = new URL(req.url)
    const boardId = searchParams.get('boardId')
    if (!boardId) {
      return apiError(400, 'boardId query parameter is required')
    }

    await resolveBoard(boardId, session.orgId)

    const sprints = await prisma.sprint.findMany({
      where: { boardId },
      orderBy: { startDate: 'asc' },
    })

    return NextResponse.json({ sprints })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/sprints error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/sprints
// Creates a new sprint with status PLANNING.
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = createSprintSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { name, boardId, startDate, endDate } = result.data

    await resolveBoard(boardId, session.orgId)

    const sprint = await prisma.sprint.create({
      data: {
        name,
        boardId,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        status: 'PLANNING',
      },
    })

    return NextResponse.json({ sprint }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/sprints error:', err)
    return apiError(500, 'Internal server error')
  }
}
