import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

// GET /api/hud/dispatch/[dispatchId] — single dispatch (poll fallback for the SSE stream).
export async function GET(req: NextRequest, ctx: { params: Promise<{ dispatchId: string }> }) {
  const { dispatchId } = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const dispatch = await prisma.agentDispatch.findFirst({
      where: { id: dispatchId, orgId: session.orgId },
    })
    if (!dispatch) return apiError(404, 'Dispatch not found')

    return NextResponse.json({
      dispatch: {
        ...dispatch,
        citations: dispatch.citations ? safeParse(dispatch.citations) : null,
      },
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/hud/dispatch/[dispatchId] error:', err)
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
