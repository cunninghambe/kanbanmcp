import type { PrismaClient } from '@prisma/client'
import { MAX_NESTING_DEPTH, decodeAiReviewParams } from '@/lib/cards'
import type { AiReviewParams } from '@/lib/cards'

const DEFAULT_MODEL = 'claude-opus-4-7'

/** Returns env-configured defaults or null if rubric is not set. */
export function envDefaultParams(): AiReviewParams | null {
  const rubric = process.env.AI_REVIEW_DEFAULT_RUBRIC
  if (!rubric) return null
  return {
    model: process.env.AI_REVIEW_DEFAULT_MODEL ?? DEFAULT_MODEL,
    rubric,
  }
}

/**
 * Walks the parentCardId chain from cardId, returning the first non-null
 * decoded aiReviewParams. Falls back to env defaults if nothing is found.
 * Hard-stops after MAX_NESTING_DEPTH iterations to handle corrupt chains.
 */
export async function resolveEffectiveAiReviewParams(
  prisma: PrismaClient,
  cardId: string
): Promise<AiReviewParams | null> {
  let currentId: string | null = cardId

  for (let i = 0; i < MAX_NESTING_DEPTH; i++) {
    if (!currentId) break

    const card: { aiReviewParams: string | null; parentCardId: string | null } | null =
      await prisma.card.findUnique({
        where: { id: currentId },
        select: { aiReviewParams: true, parentCardId: true },
      })

    if (!card) break

    const params = decodeAiReviewParams(card.aiReviewParams)
    if (params) return params

    currentId = card.parentCardId
  }

  return envDefaultParams()
}
