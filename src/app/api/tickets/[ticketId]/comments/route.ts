import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { requireApiKey } from '@/lib/agent-auth'

const createCommentSchema = z.object({
  content: z.string().min(1, 'Comment content is required'),
  internal: z.boolean().optional(),
})

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

async function resolveTicket(ticketId: string, orgId: string) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
  if (!ticket) throw NextResponse.json({ error: 'Ticket not found' }, { status: 404 })
  if (ticket.orgId !== orgId) throw NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return ticket
}

// GET /api/tickets/[ticketId]/comments
export async function GET(
  req: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const auth = await resolveAuth(req)
    await resolveTicket(params.ticketId, auth.orgId)

    const comments = await prisma.ticketComment.findMany({
      where: { ticketId: params.ticketId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    })

    return NextResponse.json({ comments })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/tickets/[ticketId]/comments error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/tickets/[ticketId]/comments
export async function POST(
  req: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const auth = await resolveAuth(req)
    await resolveTicket(params.ticketId, auth.orgId)

    const body = await req.json()
    const result = createCommentSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const comment = await prisma.ticketComment.create({
      data: {
        ticketId: params.ticketId,
        userId: auth.userId ?? null,
        agentName: auth.agentName ?? null,
        content: result.data.content,
        internal: result.data.internal ?? false,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    })

    // Log comment activity
    await prisma.ticketActivity.create({
      data: {
        ticketId: params.ticketId,
        userId: auth.userId ?? null,
        agentName: auth.agentName ?? null,
        action: 'commented',
      },
    })

    return NextResponse.json({ comment }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/tickets/[ticketId]/comments error:', err)
    return apiError(500, 'Internal server error')
  }
}
