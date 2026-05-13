import { PrismaClient } from '@prisma/client'

export const AI_REVIEWER_EMAIL = 'ai-reviewer@kanbanmcp.local'
export const AI_REVIEWER_NAME = 'AI Reviewer'

// Unusable bcrypt hash — service account, login is blocked by isAgent check in auth/login route.
const AI_REVIEWER_PASSWORD_HASH = '$2a$12$I2IzYybCYMKhJG4L6DFE5.DDzTl09Ak7/5VjVPDmJO.OM/pqIS6e2'

export async function ensureAiReviewerUser(
  prisma: PrismaClient
): Promise<{ id: string; email: string; name: string }> {
  const user = await prisma.user.upsert({
    where: { email: AI_REVIEWER_EMAIL },
    update: {},
    create: {
      email: AI_REVIEWER_EMAIL,
      name: AI_REVIEWER_NAME,
      passwordHash: AI_REVIEWER_PASSWORD_HASH,
      isAgent: true,
    },
  })

  console.log(`[seed-ai-reviewer] id=${user.id}`)

  return { id: user.id, email: user.email, name: user.name }
}

if (require.main === module) {
  const prisma = new PrismaClient()
  ensureAiReviewerUser(prisma)
    .catch((e: unknown) => {
      console.error(e)
      process.exit(1)
    })
    .finally(() => prisma.$disconnect())
}
