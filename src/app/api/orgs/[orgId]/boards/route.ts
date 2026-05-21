import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { slugifyBoardName } from '@/lib/card-execution/projects'
import { ensureProjectDirectory, upsertProject, reloadClaudeMcp } from '@/lib/claude-mcp-registry'

const createBoardSchema = z.object({
  name: z.string().min(1, 'Board name is required').max(255),
  repoPath: z.string().min(1).optional(),
})

type ClaudeRegistration =
  | { ok: true; project: string; path: string }
  | { ok: false; error: string }

const DEFAULT_COLUMNS = [
  { name: 'Backlog', position: 0 },
  { name: 'In Progress', position: 1 },
  { name: 'Review', position: 2 },
  { name: 'Blocked', position: 3 },
  { name: 'Done', position: 4 },
]

// GET /api/orgs/[orgId]/boards
// Returns all boards for the org with columnCount and cardCount.
export async function GET(req: NextRequest, ctx: { params: Promise<{ orgId: string }> }) {
  const params = await ctx.params
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
// Creates a new board and auto-creates 5 default columns. Requires ADMIN role.
export async function POST(req: NextRequest, ctx: { params: Promise<{ orgId: string }> }) {
  const params = await ctx.params
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

    const slug = slugifyBoardName(result.data.name)
    let claudeRegistration: ClaudeRegistration | undefined

    if (result.data.repoPath && slug) {
      try {
        await ensureProjectDirectory(result.data.repoPath, 'main')
        await upsertProject(slug, result.data.repoPath, 'main')
        await reloadClaudeMcp()
        claudeRegistration = { ok: true, project: slug, path: result.data.repoPath }
      } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr)
        console.error('POST /api/orgs/[orgId]/boards: claude registration failed:', msg)
        claudeRegistration = { ok: false, error: msg }
      }
    }

    return NextResponse.json(
      claudeRegistration !== undefined
        ? { board, columns, claudeRegistration }
        : { board, columns },
      { status: 201 }
    )
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/orgs/[orgId]/boards error:', err)
    return apiError(500, 'Internal server error')
  }
}
