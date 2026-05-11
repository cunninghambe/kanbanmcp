import type { Artifact, User, AiReview } from '@prisma/client'

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024 // 25 MB

// MIME note: file.type is client-supplied and not cryptographically verified.
// A future hardening step could use file-type to sniff content — out of scope for M1.
export const ALLOWED_MIME_TYPES: ReadonlyArray<string> = [
  'application/pdf',
  'application/json',
  'application/x-yaml',
  'text/markdown',
  'text/plain',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/webp',
]

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME_TYPES.includes(mime)
}

export type AiReviewSummary = {
  id: string
  status: string
  model: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type ArtifactResponse = {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  source: string
  createdAt: string
  uploader: { id: string; name: string; email: string }
  reviews: AiReviewSummary[]
}

export function shapeArtifact(
  a: Artifact & { uploader: User; reviews: AiReview[] }
): ArtifactResponse {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    source: a.source,
    createdAt: a.createdAt.toISOString(),
    uploader: { id: a.uploader.id, name: a.uploader.name, email: a.uploader.email },
    reviews: a.reviews.map((r) => ({
      id: r.id,
      status: r.status,
      model: r.model,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
  }
}
