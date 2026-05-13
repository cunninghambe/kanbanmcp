import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendEmail } from '@/lib/email'

function buildDigestBody(
  userName: string,
  categories: {
    asAssignee: { title: string; boardName: string }[]
    asReviewer: { title: string; boardName: string }[]
    asApprover: { title: string; boardName: string }[]
    overdue: { title: string; boardName: string }[]
  }
): string {
  const lines: string[] = [`<h2>Hi ${userName},</h2>`, `<p>Here's your KanbanMCP daily digest:</p>`]

  if (categories.overdue.length > 0) {
    lines.push('<h3>Overdue</h3><ul>')
    for (const c of categories.overdue) lines.push(`<li><b>${c.title}</b> (${c.boardName})</li>`)
    lines.push('</ul>')
  }

  if (categories.asReviewer.length + categories.asApprover.length > 0) {
    lines.push('<h3>Needs your action</h3><ul>')
    for (const c of categories.asReviewer) lines.push(`<li>[Review] <b>${c.title}</b> (${c.boardName})</li>`)
    for (const c of categories.asApprover) lines.push(`<li>[Approve] <b>${c.title}</b> (${c.boardName})</li>`)
    lines.push('</ul>')
  }

  if (categories.asAssignee.length > 0) {
    lines.push('<h3>Assigned to you</h3><ul>')
    for (const c of categories.asAssignee) lines.push(`<li><b>${c.title}</b> (${c.boardName})</li>`)
    lines.push('</ul>')
  }

  return lines.join('\n')
}

// POST /api/cron/digest
// Sends a daily digest email to every user who has at least one assignment.
// Requires Authorization: Bearer <CRON_SECRET>.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  // Fetch all users with their org memberships so we can scope by org
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      orgMembers: { select: { orgId: true } },
    },
  })

  let sent = 0

  for (const user of users) {
    const orgIds = user.orgMembers.map((m) => m.orgId)
    if (orgIds.length === 0) continue

    const [assigneeCards, reviewerCards, approverCards] = await Promise.all([
      prisma.card.findMany({
        where: {
          assigneeId: user.id,
          board: { orgId: { in: orgIds } },
          column: { NOT: { name: 'Done' } },
        },
        include: {
          board: { select: { name: true } },
          signoffs: { orderBy: { createdAt: 'desc' } },
        },
      }),
      prisma.card.findMany({
        where: {
          reviewerId: user.id,
          board: { orgId: { in: orgIds } },
          column: { NOT: { name: 'Done' } },
        },
        include: {
          board: { select: { name: true } },
          signoffs: { orderBy: { createdAt: 'desc' } },
        },
      }),
      prisma.card.findMany({
        where: {
          approverId: user.id,
          board: { orgId: { in: orgIds } },
          column: { NOT: { name: 'Done' } },
        },
        include: {
          board: { select: { name: true } },
          signoffs: { orderBy: { createdAt: 'desc' } },
        },
      }),
    ])

    const reviewerNeedsAction = reviewerCards.filter((c) => {
      const latest = c.signoffs.find((s) => s.role === 'REVIEWER')
      return !latest || latest.decision === 'REQUESTED_CHANGES'
    })

    const approverNeedsAction = approverCards.filter((c) => {
      const latest = c.signoffs.find((s) => s.role === 'APPROVER')
      return !latest || latest.decision === 'REQUESTED_CHANGES'
    })

    const overdueCards = assigneeCards.filter(
      (c) => c.dueDate !== null && new Date(c.dueDate) < now
    )
    const assigneeOnly = assigneeCards.filter(
      (c) => c.dueDate === null || new Date(c.dueDate) >= now
    )

    const totalItems =
      assigneeOnly.length + reviewerNeedsAction.length + approverNeedsAction.length + overdueCards.length

    if (totalItems === 0) continue

    const body = buildDigestBody(user.name, {
      asAssignee: assigneeOnly.map((c) => ({ title: c.title, boardName: c.board.name })),
      asReviewer: reviewerNeedsAction.map((c) => ({ title: c.title, boardName: c.board.name })),
      asApprover: approverNeedsAction.map((c) => ({ title: c.title, boardName: c.board.name })),
      overdue: overdueCards.map((c) => ({ title: c.title, boardName: c.board.name })),
    })

    await sendEmail(user.email, 'Your KanbanMCP daily digest', body)
    sent++
  }

  return NextResponse.json({ sent })
}
