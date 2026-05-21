import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { slugifyBoardName } from '@/lib/card-execution/projects'
import { ensureProjectDirectory, upsertProject, reloadClaudeMcp } from '@/lib/claude-mcp-registry'

const bodySchema = z.object({
  repoPath: z.string().min(1),
})

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string }> }
) {
  const params = await ctx.params
  try {
    const session = await requireSession(req)

    const board = await prisma.board.findUnique({ where: { id: params.boardId } })
    if (!board) return apiError(404, 'Board not found')

    if (session.orgId !== board.orgId) return apiError(404, 'Board not found')

    await requireOrgRole(session, board.orgId, 'ADMIN')

    const raw = await req.json()
    const parsed = bodySchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 }
      )
    }

    const slug = slugifyBoardName(board.name)
    if (!slug) return apiError(400, 'Board name does not produce a valid project slug')

    const { repoPath } = parsed.data
    await ensureProjectDirectory(repoPath, 'main')
    await upsertProject(slug, repoPath, 'main')
    await reloadClaudeMcp()

    return NextResponse.json({ ok: true, project: slug, path: repoPath })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST register-claude-project error:', err)
    return apiError(500, err instanceof Error ? err.message : 'Internal server error')
  }
}
