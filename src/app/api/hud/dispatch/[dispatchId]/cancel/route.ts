import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

// POST /api/hud/dispatch/[dispatchId]/cancel — cancel an in-flight dispatch. Human only.
// The worker observes the `cancelled` status on its next poll and stops.
export async function POST(req: NextRequest, ctx: { params: Promise<{ dispatchId: string }> }) {
  const { dispatchId } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'Cancelling a dispatch requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const dispatch = await prisma.agentDispatch.findFirst({
      where: { id: dispatchId, orgId: session.orgId },
      select: { id: true, status: true },
    })
    if (!dispatch) return apiError(404, 'Dispatch not found')
    if (['done', 'failed', 'cancelled'].includes(dispatch.status)) {
      return apiError(409, `Dispatch already ${dispatch.status}`)
    }

    const updated = await prisma.agentDispatch.update({
      where: { id: dispatchId },
      data: { status: 'cancelled', finishedAt: new Date() },
    })
    return NextResponse.json({ dispatch: updated })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/hud/dispatch/[dispatchId]/cancel error:', err)
    return apiError(500, 'Internal server error')
  }
}
