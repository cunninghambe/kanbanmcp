import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { requireApiKey } from '@/lib/agent-auth'

async function resolveAuth(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const agent = await requireApiKey(req)
    return { orgId: agent.orgId, agentName: agent.agentName, userId: undefined }
  }
  const session = await requireSession(req)
  await requireOrgRole(session, session.orgId, 'MEMBER')
  return { orgId: session.orgId, userId: session.userId, agentName: undefined }
}

// GET /api/tickets/[ticketId]/activity
// Returns the full activity log for a ticket.
export async function GET(
  req: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const auth = await resolveAuth(req)

    const ticket = await prisma.ticket.findUnique({ where: { id: params.ticketId } })
    if (!ticket) return apiError(404, 'Ticket not found')
    if (ticket.orgId !== auth.orgId) return apiError(403, 'Forbidden')

    const activity = await prisma.ticketActivity.findMany({
      where: { ticketId: params.ticketId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    })

    return NextResponse.json({ activity })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/tickets/[ticketId]/activity error:', err)
    return apiError(500, 'Internal server error')
  }
}
