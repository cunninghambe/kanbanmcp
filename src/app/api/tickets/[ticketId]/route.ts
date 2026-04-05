import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { requireApiKey } from '@/lib/agent-auth'

const VALID_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'] as const
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

const updateTicketSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  status: z.enum(VALID_STATUSES).optional(),
  priority: z.enum(VALID_PRIORITIES).optional(),
  assigneeId: z.string().nullable().optional(),
})

/**
 * Authenticates either a session user or an API-key agent.
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

/**
 * Resolves the ticket, verifying it belongs to the caller's org.
 */
async function resolveTicket(ticketId: string, orgId: string) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
  if (!ticket) {
    throw NextResponse.json({ error: 'Ticket not found' }, { status: 404 })
  }
  if (ticket.orgId !== orgId) {
    throw NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return ticket
}

// GET /api/tickets/[ticketId]
export async function GET(
  req: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const auth = await resolveAuth(req)
    await resolveTicket(params.ticketId, auth.orgId)

    const ticket = await prisma.ticket.findUnique({
      where: { id: params.ticketId },
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        assignee: { select: { id: true, name: true, email: true } },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
        activity: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    })

    return NextResponse.json({ ticket })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/tickets/[ticketId] error:', err)
    return apiError(500, 'Internal server error')
  }
}

// PATCH /api/tickets/[ticketId]
// Updates ticket fields. Logs activity entries for status/priority/assignee changes.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const auth = await resolveAuth(req)
    const existing = await resolveTicket(params.ticketId, auth.orgId)

    const body = await req.json()
    const result = updateTicketSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { title, description, status, priority, assigneeId } = result.data

    // Validate assigneeId membership
    if (assigneeId !== undefined && assigneeId !== null) {
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

    // Build update data and collect activity entries
    const updateData: Record<string, unknown> = { updatedAt: new Date() }
    const activityEntries: { action: string; fromValue?: string; toValue?: string }[] = []

    if (title !== undefined && title !== existing.title) {
      activityEntries.push({ action: 'title_changed', fromValue: existing.title, toValue: title })
      updateData.title = title
    }
    if (description !== undefined) {
      updateData.description = description
    }
    if (status !== undefined && status !== existing.status) {
      activityEntries.push({ action: 'status_changed', fromValue: existing.status, toValue: status })
      updateData.status = status
      if (status === 'resolved' && !existing.resolvedAt) updateData.resolvedAt = new Date()
      if (status === 'closed' && !existing.closedAt) updateData.closedAt = new Date()
      // Re-open: clear resolved/closed timestamps
      if (status === 'open' || status === 'in_progress' || status === 'waiting') {
        if (existing.status === 'resolved') updateData.resolvedAt = null
        if (existing.status === 'closed') updateData.closedAt = null
      }
    }
    if (priority !== undefined && priority !== existing.priority) {
      activityEntries.push({ action: 'priority_changed', fromValue: existing.priority, toValue: priority })
      updateData.priority = priority
    }
    if (assigneeId !== undefined && assigneeId !== existing.assigneeId) {
      activityEntries.push({ action: 'assigned', fromValue: existing.assigneeId ?? undefined, toValue: assigneeId ?? undefined })
      updateData.assigneeId = assigneeId
    }

    await prisma.$transaction(async (tx) => {
      if (Object.keys(updateData).length > 1) {
        await tx.ticket.update({ where: { id: params.ticketId }, data: updateData })
      }
      for (const entry of activityEntries) {
        await tx.ticketActivity.create({
          data: {
            ticketId: params.ticketId,
            userId: auth.userId ?? null,
            agentName: auth.agentName ?? null,
            action: entry.action,
            fromValue: entry.fromValue ?? null,
            toValue: entry.toValue ?? null,
          },
        })
      }
    })

    const ticket = await prisma.ticket.findUnique({
      where: { id: params.ticketId },
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        assignee: { select: { id: true, name: true, email: true } },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        activity: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    })

    return NextResponse.json({ ticket })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('PATCH /api/tickets/[ticketId] error:', err)
    return apiError(500, 'Internal server error')
  }
}

// DELETE /api/tickets/[ticketId]
// Hard-deletes the ticket. Cascades handle comments and activity.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const auth = await resolveAuth(req)
    await resolveTicket(params.ticketId, auth.orgId)

    await prisma.ticket.delete({ where: { id: params.ticketId } })

    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('DELETE /api/tickets/[ticketId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
