import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

// GET /api/hud/[id] — session detail with its dispatches (newest first).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const hud = await prisma.hudSession.findFirst({
      where: { id, orgId: session.orgId },
      include: { dispatches: { orderBy: { createdAt: 'desc' } } },
    })
    if (!hud) return apiError(404, 'HUD session not found')

    return NextResponse.json({
      session: hud,
      dispatches: hud.dispatches.map((d) => ({
        ...d,
        citations: d.citations ? safeParse(d.citations) : null,
      })),
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/hud/[id] error:', err)
    return apiError(500, 'Internal server error')
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
