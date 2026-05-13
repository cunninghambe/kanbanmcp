import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { enqueueCardDescriptionReview } from '@/lib/ai-review/queue'
import { shapeReview } from '@/lib/ai-review/response'

async function resolveCardOrgId(cardId: string): Promise<string | null> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { board: { select: { orgId: true } } },
  })
  return card?.board.orgId ?? null
}

// POST /api/cards/[cardId]/reviews
// Triggers a description-only AI review for the card.
export async function POST(req: NextRequest, ctx: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const orgId = await resolveCardOrgId(cardId)
    if (!orgId || orgId !== session.orgId) return apiError(404, 'Card not found')

    // Validate description is present and non-empty
    const card = await prisma.card.findUnique({
      where: { id: cardId },
      select: { description: true },
    })
    if (!card) return apiError(404, 'Card not found')
    if (!card.description?.trim()) return apiError(400, 'Card has no description to review')

    const enqueued = await enqueueCardDescriptionReview(cardId)
    if (!enqueued) return apiError(409, 'A review is already pending or running')

    const review = await prisma.aiReview.findFirst({
      where: { cardId, artifactId: null, status: { in: ['pending', 'failed'] } },
      orderBy: { createdAt: 'desc' },
    })

    if (!review) return apiError(500, 'Internal server error')

    return NextResponse.json({ review: shapeReview(review) }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/cards/[cardId]/reviews error:', err)
    return apiError(500, 'Internal server error')
  }
}

// GET /api/cards/[cardId]/reviews
// Returns all reviews for a card (artifact + description) ordered by createdAt DESC.
export async function GET(req: NextRequest, ctx: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const orgId = await resolveCardOrgId(cardId)
    if (!orgId || orgId !== session.orgId) return apiError(404, 'Card not found')

    const reviews = await prisma.aiReview.findMany({
      where: { cardId },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ reviews: reviews.map(shapeReview) })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/cards/[cardId]/reviews error:', err)
    return apiError(500, 'Internal server error')
  }
}
