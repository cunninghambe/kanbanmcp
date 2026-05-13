import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { shapeReview } from '@/lib/ai-review/response'
export type { AiReviewResponse } from '@/lib/ai-review/response'

// GET /api/reviews/[reviewId]
export async function GET(req: NextRequest, ctx: { params: Promise<{ reviewId: string }> }) {
  const params = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const review = await prisma.aiReview.findUnique({
      where: { id: params.reviewId },
      include: {
        artifact: {
          select: { card: { select: { board: { select: { orgId: true } } } } },
        },
      },
    })

    if (!review) return apiError(404, 'Review not found')
    if (review.artifact.card.board.orgId !== session.orgId) return apiError(404, 'Review not found')

    return NextResponse.json({ review: shapeReview(review) })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/reviews/[reviewId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
