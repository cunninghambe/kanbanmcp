import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'

/**
 * GET /api/me/ai-review-queue
 *
 * Returns the 10 most recent in-flight (pending or running) AI reviews
 * for cards that belong to the session user's org. Used by the Dashboard
 * AI review queue widget — no per-card aggregate endpoint exists elsewhere.
 *
 * Response shape:
 *   { reviews: AiReviewQueueItem[] }
 */
export type AiReviewQueueItem = {
  id: string
  cardId: string
  cardTitle: string
  artifactName: string | null
  model: string
  status: string
  createdAt: string
  startedAt: string | null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession(req)

    const rows = await prisma.aiReview.findMany({
      where: {
        status: { in: ['pending', 'running'] },
        card: { board: { orgId: session.orgId } },
      },
      include: {
        card: { select: { title: true } },
        artifact: { select: { filename: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })

    const reviews: AiReviewQueueItem[] = rows.map((r) => ({
      id: r.id,
      cardId: r.cardId,
      cardTitle: r.card.title,
      artifactName: r.artifact?.filename ?? null,
      model: r.model,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
    }))

    return NextResponse.json({ reviews })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/me/ai-review-queue error:', err)
    return apiError(500, 'Internal server error')
  }
}
