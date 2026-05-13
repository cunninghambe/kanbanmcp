import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import { ensureAiReviewerUser } from './seed-ai-reviewer'

const prisma = new PrismaClient()

async function main() {
  // Idempotent: re-running seed against an existing DB is allowed.
  const org = await prisma.organization.upsert({
    where: { slug: 'demo' },
    update: {},
    create: { name: 'Demo Org', slug: 'demo' },
  })

  const passwordHash = await bcrypt.hash('demo1234', 12)
  const user = await prisma.user.upsert({
    where: { email: 'admin@demo.com' },
    update: {},
    create: {
      email: 'admin@demo.com',
      name: 'Admin User',
      passwordHash,
    },
  })

  await prisma.orgMember.upsert({
    where: { userId_orgId: { userId: user.id, orgId: org.id } },
    update: {},
    create: {
      userId: user.id,
      orgId: org.id,
      role: 'ADMIN',
    },
  })

  // Skip board/sprint/cards creation if a board already exists for this org
  const existingBoard = await prisma.board.findFirst({ where: { orgId: org.id } })
  if (existingBoard) {
    await ensureAiReviewerUser(prisma)
    console.log('Seed: existing data preserved; AI Reviewer user ensured')
    return
  }

  // Create board
  const board = await prisma.board.create({
    data: {
      name: 'Demo Board',
      orgId: org.id,
    },
  })

  // Create 4 columns
  const columns = await Promise.all(
    [
      { name: 'Backlog', position: 0 },
      { name: 'In Progress', position: 1 },
      { name: 'Review', position: 2 },
      { name: 'Done', position: 3 },
    ].map((col) =>
      prisma.column.create({
        data: {
          name: col.name,
          position: col.position,
          boardId: board.id,
        },
      })
    )
  )

  const [backlog, inProgress, review, done] = columns

  // Create sprint
  const now = new Date()
  const twoWeeksLater = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

  const sprint = await prisma.sprint.create({
    data: {
      name: 'Sprint 1',
      boardId: board.id,
      startDate: now,
      endDate: twoWeeksLater,
      status: 'ACTIVE',
    },
  })

  // Create 6 sample cards distributed across columns
  const cards = [
    { title: 'Set up authentication', columnId: backlog.id, position: 0 },
    { title: 'Design database schema', columnId: backlog.id, position: 1 },
    { title: 'Implement REST API endpoints', columnId: inProgress.id, position: 0 },
    { title: 'Build kanban board UI', columnId: inProgress.id, position: 1 },
    { title: 'Add drag-and-drop support', columnId: review.id, position: 0 },
    { title: 'Deploy to production', columnId: done.id, position: 0 },
  ]

  for (const card of cards) {
    await prisma.card.create({
      data: {
        title: card.title,
        columnId: card.columnId,
        boardId: board.id,
        sprintId: sprint.id,
        position: card.position,
        createdById: user.id,
      },
    })
  }

  await ensureAiReviewerUser(prisma)

  console.log('Seed data created successfully')
  console.log(`  Organization: ${org.name} (${org.slug})`)
  console.log(`  User: ${user.email}`)
  console.log(`  Board: ${board.name}`)
  console.log(`  Columns: ${columns.map((c) => c.name).join(', ')}`)
  console.log(`  Sprint: ${sprint.name} (${sprint.status})`)
  console.log(`  Cards: ${cards.length}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
