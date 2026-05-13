import { z } from 'zod'
import type { PrismaClient } from '@prisma/client'

export const MAX_NESTING_DEPTH = 50

export const aiReviewParamsSchema = z.object({
  model: z.string().min(1).max(200),
  rubric: z.string().min(1).max(10000),
  customInstructions: z.string().max(10000).optional(),
})

export type AiReviewParams = z.infer<typeof aiReviewParamsSchema>

/**
 * Computes the path and depth for a child card given its parent.
 * Root card has path "". Child of root has path "/rootId/". Grandchild has "/rootId/childId/".
 * Rejection at parent.depth + 1 >= MAX_NESTING_DEPTH (i.e. parent at depth 49 -> 400).
 */
export function computeChildPathAndDepth(parent: { id: string; path: string; depth: number }): {
  path: string
  depth: number
} {
  const prefix = parent.path === '' ? '/' : parent.path
  return {
    path: `${prefix}${parent.id}/`,
    depth: parent.depth + 1,
  }
}

/**
 * Checks that all provided userIds are members of the given org.
 * Deduplicates ids, runs one query, returns the first missing id if any.
 */
export async function roleMembershipCheck(
  prisma: Pick<PrismaClient, 'orgMember'>,
  userIds: ReadonlyArray<string>,
  orgId: string
): Promise<{ ok: true } | { ok: false; missingId: string }> {
  const deduped = [...new Set(userIds)]
  if (deduped.length === 0) return { ok: true }

  const found = await prisma.orgMember.findMany({
    where: { orgId, userId: { in: deduped } },
    select: { userId: true },
  })
  const foundSet = new Set(found.map((m) => m.userId))

  for (const id of deduped) {
    if (!foundSet.has(id)) return { ok: false, missingId: id }
  }
  return { ok: true }
}

/**
 * Parses a stored aiReviewParams JSON string back to an object.
 * Returns null if the string is null, invalid JSON, or fails schema validation.
 */
export function decodeAiReviewParams(raw: string | null): AiReviewParams | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const result = aiReviewParamsSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
