import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError, paginationParams } from '@/lib/api-helpers'
import { requireApiKey } from '@/lib/agent-auth'

const VALID_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'] as const
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

const createTicketSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().nullable().optional(),
  priority: z.enum(VALID_PRIORITIES).optional(),
  assigneeId: z.string().nullable().optional(),
})

/**
 * Authenticates either a session user or an API-key agent.
 * Returns { orgId, userId?, agentName? }.
 */
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

// GET /api/tickets
// Lists tickets for the current org. Supports ?status=, ?priority=, ?assigneeId=, page, limit.
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuth(req)
    const { page, limit, skip } = paginationParams(req.url)

    const { searchParams } = new URL(req.url)
    const statusFilter = searchParams.get('status')
    const priorityFilter = searchParams.get('priority')
    const assigneeFilter = searchParams.get('assigneeId')
    const searchQuery = searchParams.get('q')

    const where: Record<string, unknown> = { orgId: auth.orgId }
    if (statusFilter) where.status = statusFilter
    if (priorityFilter) where.priority = priorityFilter
    if (assigneeFilter) where.assigneeId = assigneeFilter
    if (searchQuery) {
      where.OR = [
        { title: { contains: searchQuery } },
        { description: { contains: searchQuery } },
      ]
    }

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
        include: {
          reporter: { select: { id: true, name: true, email: true } },
          assignee: { select: { id: true, name: true, email: true } },
          _count: { select: { comments: true } },
        },
      }),
      prisma.ticket.count({ where }),
    ])

    return NextResponse.json({
      tickets,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/tickets error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/tickets
// Creates a new ticket.
export async function POST(req: NextRequest) {
  try {
    const auth = await resolveAuth(req)

    const body = await req.json()
    const result = createTicketSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { title, description, priority, assigneeId } = result.data

    // Validate assigneeId belongs to this org
    if (assigneeId) {
      const member = await prisma.orgMember.findUnique({
        where: { userId_orgId: { userId: assigneeId, orgId: auth.orgId } },
      })
      if (!member) {
        return NextResponse.json(
          { error: 'Assignee must be a member of this organization' },
          { status: 400 }
        )
      }
    }

    // Auto-increment ticket number per org
    const lastTicket = await prisma.ticket.findFirst({
      where: { orgId: auth.orgId },
      orderBy: { number: 'desc' },
      select: { number: true },
    })
    const number = (lastTicket?.number ?? 0) + 1

    const ticket = await prisma.ticket.create({
      data: {
        orgId: auth.orgId,
        number,
        title,
        description: description ?? null,
        priority: priority ?? 'medium',
        status: 'open',
        reporterId: auth.userId ?? null,
        agentName: auth.agentName ?? null,
        assigneeId: assigneeId ?? null,
      },
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        assignee: { select: { id: true, name: true, email: true } },
      },
    })

    // Log creation activity
    await prisma.ticketActivity.create({
      data: {
        ticketId: ticket.id,
        userId: auth.userId ?? null,
        agentName: auth.agentName ?? null,
        action: 'created',
        toValue: title,
      },
    })

    return NextResponse.json({ ticket }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/tickets error:', err)
    return apiError(500, 'Internal server error')
  }
}
