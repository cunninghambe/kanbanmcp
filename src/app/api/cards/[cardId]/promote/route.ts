import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { recomputeSubtreePathAndDepth } from '@/lib/tree'
import { decodeAiReviewParams } from '@/lib/cards'
import { resolveCard } from '@/lib/resolve-card'

// POST /api/cards/[cardId]/promote
export async function POST(
  req: NextRequest,
  { params }: { params: { cardId: string } }
) {
  try {
    const session = await requireSession(req)
    const existingCard = await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    if (existingCard.parentCardId === null) {
      const card = await prisma.card.findUnique({ where: { id: params.cardId } })
      return NextResponse.json({
        card: { ...card, aiReviewParams: decodeAiReviewParams(card?.aiReviewParams ?? null) },
      })
    }

    await prisma.$transaction(async (tx) => {
      await tx.card.update({
        where: { id: params.cardId },
        data: { parentCardId: null },
      })
      await recomputeSubtreePathAndDepth(tx, params.cardId, null)
    })

    const card = await prisma.card.findUnique({ where: { id: params.cardId } })
    return NextResponse.json({
      card: { ...card, aiReviewParams: decodeAiReviewParams(card?.aiReviewParams ?? null) },
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/cards/[cardId]/promote error:', err)
    return apiError(500, 'Internal server error')
  }
}
