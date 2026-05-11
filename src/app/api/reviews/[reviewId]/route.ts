import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import type { AiReviewResponse } from '@/app/api/artifacts/[artifactId]/reviews/route'

function shapeReview(r: {
  id: string
  artifactId: string
  status: string
  model: string
  rubricSnapshot: string
  instructions: string | null
  output: string | null
  errorMessage: string | null
  inputTokens: number | null
  outputTokens: number | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}): AiReviewResponse {
  return {
    id: r.id,
    artifactId: r.artifactId,
    status: r.status,
    model: r.model,
    rubricSnapshot: r.rubricSnapshot,
    instructions: r.instructions,
    output: r.output,
    errorMessage: r.errorMessage,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}

// GET /api/reviews/[reviewId]
export async function GET(
  req: NextRequest,
  { params }: { params: { reviewId: string } }
) {
  try {
    const session = await requireSession(req)

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

    await requireOrgRole(session, session.orgId, 'MEMBER')

    return NextResponse.json({ review: shapeReview(review) })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/reviews/[reviewId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
