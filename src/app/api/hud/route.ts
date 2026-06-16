import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { logActivity } from '@/lib/agent-activity'

const createSchema = z.object({
  title: z.string().min(1, 'title is required'),
  boardId: z.string().optional(),
  seriesId: z.string().optional(),
  meetingId: z.string().optional(),
})

// GET /api/hud — list the org's HUD sessions (newest first).
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const sessions = await prisma.hudSession.findMany({
      where: { orgId: session.orgId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    })
    return NextResponse.json({ sessions })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/hud error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/hud — start a live HUD session. Human session only (the chair is present).
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) {
      return apiError(403, 'Starting a HUD session requires a human session')
    }
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const parsed = createSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    // If a board is named, it must belong to the chair's org.
    if (parsed.data.boardId) {
      const board = await prisma.board.findFirst({
        where: { id: parsed.data.boardId, orgId: session.orgId },
        select: { id: true },
      })
      if (!board) return apiError(404, 'Board not found')
    }

    const hud = await prisma.hudSession.create({
      data: {
        orgId: session.orgId,
        chairId: session.userId,
        title: parsed.data.title,
        boardId: parsed.data.boardId ?? null,
        seriesId: parsed.data.seriesId ?? null,
        meetingId: parsed.data.meetingId ?? null,
      },
    })

    logActivity(session.orgId, session.userId, 'start_hud', 'hud_session', hud.id, {
      boardId: hud.boardId,
    }).catch(() => {})

    return NextResponse.json({ session: hud }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/hud error:', err)
    return apiError(500, 'Internal server error')
  }
}
