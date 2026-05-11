import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { enqueueAiReview } from '@/lib/ai-review/queue'
import type { AiReview } from '@prisma/client'

export interface AiReviewResponse {
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
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

function shapeReview(r: AiReview): AiReviewResponse {
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

async function resolveArtifactOrgId(artifactId: string): Promise<string | null> {
  const artifact = await prisma.artifact.findUnique({
    where: { id: artifactId },
    select: { card: { select: { board: { select: { orgId: true } } } } },
  })
  return artifact?.card.board.orgId ?? null
}

// GET /api/artifacts/[artifactId]/reviews
export async function GET(
  req: NextRequest,
  { params }: { params: { artifactId: string } }
) {
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
export async function POST(
  req: NextRequest,
  { params }: { params: { artifactId: string } }
) {
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
