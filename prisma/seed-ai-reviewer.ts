import { PrismaClient } from '@prisma/client'

export const AI_REVIEWER_EMAIL = 'ai-reviewer@kanbanmcp.local'
export const AI_REVIEWER_NAME = 'AI Reviewer'

// passwordHash is intentionally unusable; this account is for AI-authored comments only.
// Hash of '!unusable-clh7k9x2m0000qwerty1234abcd', computed once with bcrypt.hash(str, 12).
const AI_REVIEWER_PASSWORD_HASH =
  '$2a$12$7A7jNhaS3VveKnoni8QGQuc0gpyKmAC66VQHO4MXva3SsEGp/Nk7q'

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
