/**
 * seed-board.ts
 * Seeds the standard column structure for the Autogeny Backlog board.
 * Run: npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/seed-board.ts
 *
 * Idempotent: skips if columns already exist.
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const BOARD_ID = 'cmnb333jt000253fv0z5jbbel'
const ORG_ID = 'cmnb2ynkl0002eodizm26yiuc'

const COLUMNS = [
  { id: 'cmnb333jv000453fvqszyh3ev', name: 'Backlog', position: 0 },
  { id: 'cmnb4auukh4tl427x', name: 'Queue for Lux', position: 1 },
  { id: 'cmnb4auuphmkvwght', name: 'Specced', position: 2 },
  { id: 'cmnb333jv000653fvu2ofsulg', name: 'In Progress', position: 3 },
  { id: 'cmnb333jw000853fvekmhhrdx', name: 'Review', position: 4 },
  { id: 'cmnb333jw000a53fvqv2gvwv2', name: 'Done', position: 5 },
]

// Agent users for assignee list
const AGENTS = [
  { id: 'agent-lux', name: 'Lux', email: 'lux@agents.internal' },
  { id: 'agent-forge', name: 'Forge', email: 'forge@agents.internal' },
  { id: 'agent-spencer', name: 'Spencer', email: 'spencer@agents.internal' },
  { id: 'agent-trader', name: 'Trader', email: 'trader@agents.internal' },
]

async function main() {
  // Ensure columns exist
  for (const col of COLUMNS) {
    await prisma.column.upsert({
      where: { id: col.id },
      update: { name: col.name, position: col.position },
      create: { id: col.id, name: col.name, boardId: BOARD_ID, position: col.position },
    })
    console.log(`Column: ${col.name} (${col.position})`)
  }

  // Ensure agent users exist in org
  for (const agent of AGENTS) {
    await prisma.user.upsert({
      where: { id: agent.id },
      update: {},
      create: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        passwordHash: 'agent-no-login',
        orgId: ORG_ID,
      },
    })
    // Ensure org member record
    const existing = await prisma.orgMember.findFirst({
      where: { userId: agent.id, orgId: ORG_ID },
    })
    if (!existing) {
      await prisma.orgMember.create({
        data: { userId: agent.id, orgId: ORG_ID, role: 'MEMBER' },
      })
    }
    console.log(`Agent: ${agent.name}`)
  }
}

main()
  .then(() => { console.log('Done'); process.exit(0) })
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
