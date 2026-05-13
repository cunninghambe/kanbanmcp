import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { enqueueAiReview } from '@/lib/ai-review/queue'
import { shapeReview } from '@/lib/ai-review/response'
export type { AiReviewResponse } from '@/lib/ai-review/response'

async function resolveArtifactOrgId(artifactId: string): Promise<string | null> {
  const artifact = await prisma.artifact.findUnique({
    where: { id: artifactId },
    select: { card: { select: { board: { select: { orgId: true } } } } },
  })
  return artifact?.card.board.orgId ?? null
}

// GET /api/artifacts/[artifactId]/reviews
export async function GET(req: NextRequest, { params }: { params: { artifactId: string } }) {
  try {
    const session = await requireSession(req)
    const orgId = await resolveArtifactOrgId(params.artifactId)
    if (!orgId) return apiError(404, 'Artifact not found')
    if (orgId !== session.orgId) return apiError(404, 'Artifact not found')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const reviews = await prisma.aiReview.findMany({
      where: { artifactId: params.artifactId },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ reviews: reviews.map(shapeReview) })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/artifacts/[artifactId]/reviews error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/artifacts/[artifactId]/reviews — manually trigger a re-review
export async function POST(req: NextRequest, { params }: { params: { artifactId: string } }) {
  try {
    const session = await requireSession(req)
    const orgId = await resolveArtifactOrgId(params.artifactId)
    if (!orgId) return apiError(404, 'Artifact not found')
    if (orgId !== session.orgId) return apiError(404, 'Artifact not found')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    await enqueueAiReview(params.artifactId)

    // Return the newly created pending review (most recent row)
    const review = await prisma.aiReview.findFirst({
      where: { artifactId: params.artifactId },
      orderBy: { createdAt: 'desc' },
    })

    if (!review) return apiError(500, 'Review creation failed')

    return NextResponse.json({ review: shapeReview(review) }, { status: 202 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/artifacts/[artifactId]/reviews error:', err)
    return apiError(500, 'Internal server error')
  }
}
