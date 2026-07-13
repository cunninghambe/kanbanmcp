import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: 'demo' } })
  const chair = await prisma.user.findFirstOrThrow({ where: { email: 'admin@demo.com' } })
  const board = await prisma.board.findFirstOrThrow({ where: { orgId: org.id } })
  const cols = await prisma.column.findMany({ where: { boardId: board.id }, orderBy: { position: 'asc' } })
  const inProgress = cols.find((c) => c.name === 'In Progress') ?? cols[1]
  const review = cols.find((c) => c.name === 'Review') ?? cols[2]

  // Cards that drive the situation rail: one overdue, two stalled.
  const overdue = await prisma.card.create({
    data: {
      title: 'Migrate Dhaka payroll to new vendor',
      columnId: inProgress.id,
      boardId: board.id,
      priority: 'high',
      position: 90,
      createdById: chair.id,
      dueDate: new Date(Date.now() - 2 * 86_400_000),
    },
  })
  const stalledA = await prisma.card.create({
    data: { title: 'Sign handover MoU with local counsel', columnId: review.id, boardId: board.id, priority: 'critical', position: 91, createdById: chair.id },
  })
  const stalledB = await prisma.card.create({
    data: { title: 'Close out Q2 vendor invoices', columnId: inProgress.id, boardId: board.id, priority: 'medium', position: 92, createdById: chair.id },
  })

  // Force stale updatedAt (Prisma manages @updatedAt, so use raw SQL).
  const elevenDays = new Date(Date.now() - 11 * 86_400_000).toISOString()
  const sixDays = new Date(Date.now() - 6 * 86_400_000).toISOString()
  await prisma.$executeRawUnsafe(`UPDATE cards SET updatedAt = ? WHERE id = ?`, elevenDays, stalledA.id)
  await prisma.$executeRawUnsafe(`UPDATE cards SET updatedAt = ? WHERE id = ?`, sixDays, stalledB.id)

  const hud = await prisma.hudSession.create({
    data: {
      orgId: org.id,
      chairId: chair.id,
      boardId: board.id,
      title: 'Weekly Exec Sync — Bangladesh Handover',
      status: 'live',
      startedAt: new Date(Date.now() - 18 * 60_000),
    },
  })

  // A pending ChangeSet proposed by a drive dispatch (never applied live).
  const changeSet = await prisma.changeSet.create({
    data: {
      orgId: org.id,
      boardId: board.id,
      hudSessionId: hud.id,
      status: 'pending',
      createdById: 'Host Meeting HUD',
      summary: 'Handover doc says payroll is done — suggest moving the card',
      items: {
        create: [
          {
            op: 'comment_card',
            payload: JSON.stringify({ cardId: overdue.id, content: 'Drive doc "Dhaka Handover v3" (2026-06-14) confirms payroll cutover completed.' }),
            targetCardId: overdue.id,
            evidence: JSON.stringify({ quote: 'Payroll vendor cutover signed off on 14 June; final run reconciled.' }),
            confidence: 0.82,
          },
          {
            op: 'move_card',
            payload: JSON.stringify({ cardId: overdue.id, columnId: review.id, position: 1 }),
            targetCardId: overdue.id,
            evidence: JSON.stringify({ quote: 'Payroll vendor cutover signed off on 14 June.' }),
            confidence: 0.74,
          },
        ],
      },
    },
  })

  const base = Date.now()
  const mk = <T extends object>(over: T) => ({
    orgId: org.id,
    hudSessionId: hud.id,
    chairId: chair.id,
    ...over,
  })

  // newest first in the UI: queued, running, then completed
  await prisma.agentDispatch.create({
    data: mk({
      target: 'slack',
      question: 'What was decided about the Chittagong office lease in #ops today?',
      status: 'queued',
      createdAt: new Date(base - 5_000),
    }),
  })
  await prisma.agentDispatch.create({
    data: mk({
      target: 'email',
      question: 'Did we get a reply from counsel on the MoU this week?',
      status: 'running',
      startedAt: new Date(base - 9_000),
      createdAt: new Date(base - 12_000),
    }),
  })
  await prisma.agentDispatch.create({
    data: mk({
      target: 'drive',
      question: 'Find the latest Dhaka handover doc and tell me if payroll is done.',
      status: 'done',
      answer:
        "**Yes — payroll cutover is complete.** The latest doc is *Dhaka Handover v3* (updated 14 Jun 2026). It records the new vendor's first reconciled run and a sign-off from local finance.\n\n- New vendor live since **12 Jun**\n- Final legacy run reconciled **14 Jun**\n- One open item: **archive the old vendor contract**",
      citations: JSON.stringify([
        { kind: 'doc', title: 'Dhaka Handover v3', url: 'https://drive.google.com/file/d/demo', quote: 'Payroll vendor cutover signed off on 14 June; final run reconciled.' },
        { kind: 'doc', title: 'Vendor SOW (signed)', url: 'https://drive.google.com/file/d/demo2' },
      ]),
      confidence: 0.83,
      proposedChangeSetId: changeSet.id,
      jobId: 'job-demo-3',
      startedAt: new Date(base - 70_000),
      finishedAt: new Date(base - 48_000),
      createdAt: new Date(base - 75_000),
    }),
  })
  await prisma.agentDispatch.create({
    data: mk({
      target: 'board',
      question: 'What is overdue and stalled on this board right now?',
      status: 'done',
      answer:
        'Three items need attention:\n\n- **Overdue (2d):** *Migrate Dhaka payroll to new vendor* — but Drive suggests this is actually done (see the proposal below).\n- **Stalled (11d):** *Sign handover MoU with local counsel* — no movement, blocking the legal close.\n- **Stalled (6d):** *Close out Q2 vendor invoices*.',
      citations: JSON.stringify([
        { kind: 'card', id: overdue.id, title: 'Migrate Dhaka payroll to new vendor' },
        { kind: 'card', id: stalledA.id, title: 'Sign handover MoU with local counsel' },
        { kind: 'card', id: stalledB.id, title: 'Close out Q2 vendor invoices' },
      ]),
      confidence: 0.91,
      jobId: 'job-demo-4',
      startedAt: new Date(base - 130_000),
      finishedAt: new Date(base - 118_000),
      createdAt: new Date(base - 135_000),
    }),
  })

  console.log(JSON.stringify({ hudId: hud.id, changeSetId: changeSet.id, boardId: board.id }))
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
