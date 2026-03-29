import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const createBoardSchema = z.object({
  name: z.string().min(1, 'Board name is required').max(255),
})

const DEFAULT_COLUMNS = [
  { name: 'Backlog', position: 0 },
  { name: 'In Progress', position: 1 },
  { name: 'Review', position: 2 },
  { name: 'Done', position: 3 },
]

// GET /api/orgs/[orgId]/boards
// Returns all boards for the org with columnCount and cardCount.
export async function GET(
  req: NextRequest,
  { params }: { params: { orgId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, params.orgId, 'MEMBER')

    const boards = await prisma.board.findMany({
      where: { orgId: params.orgId },
      include: {
        _count: {
          select: { columns: true, cards: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    const result = boards.map((board) => ({
      ...board,
      columnCount: board._count.columns,
      cardCount: board._count.cards,
    }))

    return NextResponse.json({ boards: result })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/orgs/[orgId]/boards error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/orgs/[orgId]/boards
// Creates a new board and auto-creates 4 default columns. Requires ADMIN role.
export async function POST(
  req: NextRequest,
  { params }: { params: { orgId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, params.orgId, 'ADMIN')

    const body = await req.json()
    const result = createBoardSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    // Verify org exists
    const org = await prisma.organization.findUnique({
      where: { id: params.orgId },
    })
    if (!org) {
      return apiError(404, 'Organization not found')
    }

    // Create board and default columns atomically
    const [board, ...columns] = await prisma.$transaction(async (tx) => {
      const newBoard = await tx.board.create({
        data: {
          name: result.data.name,
          orgId: params.orgId,
        },
      })
      const newColumns = await Promise.all(
        DEFAULT_COLUMNS.map((col) =>
          tx.column.create({
            data: {
              name: col.name,
              position: col.position,
              boardId: newBoard.id,
            },
          })
        )
      )
      return [newBoard, ...newColumns]
    })

    return NextResponse.json({ board, columns }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/orgs/[orgId]/boards error:', err)
    return apiError(500, 'Internal server error')
  }
}
