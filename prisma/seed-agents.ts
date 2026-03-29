import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const AGENTS = [
  { id: 'agent-lux', name: 'Lux', email: 'lux@agents.internal' },
  { id: 'agent-forge', name: 'Forge', email: 'forge@agents.internal' },
  { id: 'agent-spencer', name: 'Spencer', email: 'spencer@agents.internal' },
  { id: 'agent-trader', name: 'Trader', email: 'trader@agents.internal' },
]

async function main() {
  console.log('Seeding agent users...')

  // Find the first org to add agents to
  const org = await prisma.organization.findFirst({
    orderBy: { createdAt: 'asc' },
  })

  if (!org) {
    console.error('No organization found. Please create an org first.')
    process.exit(1)
  }

  console.log(`Adding agents to org: ${org.name} (${org.id})`)

  for (const agent of AGENTS) {
    // Upsert user
    const user = await prisma.user.upsert({
      where: { id: agent.id },
      update: {
        name: agent.name,
        email: agent.email,
        isAgent: true,
      },
      create: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        passwordHash: '', // agents don't log in
        isAgent: true,
      },
    })

    console.log(`  Upserted user: ${user.name} (${user.id})`)

    // Upsert org membership
    await prisma.orgMember.upsert({
      where: {
        userId_orgId: {
          userId: agent.id,
          orgId: org.id,
        },
      },
      update: {},
      create: {
        userId: agent.id,
        orgId: org.id,
        role: 'MEMBER',
      },
    })

    console.log(`  Added ${agent.name} to org ${org.name}`)
  }

  console.log('Done! Agent users seeded successfully.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
