import type { AiReview } from '@prisma/client'

export interface AiReviewResponse {
  id: string
  artifactId: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
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

export function shapeReview(r: AiReview): AiReviewResponse {
  return {
    id: r.id,
    artifactId: r.artifactId,
    status: r.status as AiReviewResponse['status'],
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
