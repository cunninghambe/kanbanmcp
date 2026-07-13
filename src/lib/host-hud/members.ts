import type { PrismaClient } from '@prisma/client'

/**
 * Batched, org-scoped lookup of display names for a set of user ids — one
 * query regardless of how many ids are requested, never per-row. Shared by
 * the digest route (action-item assignee names) and the entries GET route
 * (assigneeName on each entry).
 */
export async function resolveMemberNames(
  db: PrismaClient,
  orgId: string,
  userIds: string[]
): Promise<Map<string, string>> {
  const deduped = [...new Set(userIds)]
  if (deduped.length === 0) return new Map()

  const members = await db.orgMember.findMany({
    where: { orgId, userId: { in: deduped } },
    select: { userId: true, user: { select: { name: true } } },
  })
  return new Map(members.map((m) => [m.userId, m.user.name]))
}
