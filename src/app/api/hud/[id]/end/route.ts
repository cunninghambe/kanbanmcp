import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { IN_FLIGHT_DISPATCH_STATUSES } from '@/lib/host-hud/config'

// POST /api/hud/[id]/end — end a live HUD session. Human session only.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'Ending a HUD session requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const hud = await prisma.hudSession.findFirst({
      where: { id, orgId: session.orgId },
      select: { id: true, status: true },
    })
    if (!hud) return apiError(404, 'HUD session not found')

    const updated = await prisma.hudSession.update({
      where: { id },
      data: { status: 'ended', endedAt: new Date() },
    })

    // Cancel any dispatches still in flight so their external ClaudeMCP jobs stop
    // (each worker propagates the cancellation to ClaudeMCP on its next poll).
    await prisma.agentDispatch.updateMany({
      where: { hudSessionId: id, status: { in: IN_FLIGHT_DISPATCH_STATUSES } },
      data: { status: 'cancelled', finishedAt: new Date() },
    })

    return NextResponse.json({ session: updated })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/hud/[id]/end error:', err)
    return apiError(500, 'Internal server error')
  }
}
