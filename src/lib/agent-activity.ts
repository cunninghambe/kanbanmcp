import { prisma } from '@/lib/db'

/**
 * Persists an agent activity record to the database.
 *
 * Designed to be called fire-and-forget from callers:
 *   logActivity(orgId, agentName, 'create_card', 'card', cardId, { title })
 *     .catch(() => {}) // callers should not await this
 *
 * The function itself properly awaits the database write.
 */
export async function logActivity(
  orgId: string,
  agentName: string,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await prisma.agentActivity.create({
    data: {
      orgId,
      agentName,
      action,
      resourceType,
      resourceId,
      metadata: JSON.stringify(metadata),
    },
  })
}
