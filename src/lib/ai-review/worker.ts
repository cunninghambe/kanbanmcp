import { prisma } from '@/lib/db'
import { getStorageDriver } from '@/lib/storage'
import { AI_REVIEWER_EMAIL, ensureAiReviewerUser } from '../../../prisma/seed-ai-reviewer'
import { resolveEffectiveAiReviewParams } from './inheritance'
import { extractContent, PDF_SIZE_CAP } from './extractors'
import { runClaudeReview } from './claude-client'
import type { ExtractedContent } from './extractors'
import type { AiReviewParams } from '@/lib/cards'
import type { ClaudeReviewResult } from './claude-client'

// Cached AI Reviewer user id, resolved once at runtime.
let cachedReviewerUserId: string | null = null

async function getReviewerUserId(): Promise<string | null> {
  if (cachedReviewerUserId) return cachedReviewerUserId
  if (process.env.AI_REVIEWER_USER_ID) {
    cachedReviewerUserId = process.env.AI_REVIEWER_USER_ID
    return cachedReviewerUserId
  }
  try {
    let user: { id: string } | null = await prisma.user.findUnique({
      where: { email: AI_REVIEWER_EMAIL },
      select: { id: true },
    })
    if (!user) {
      console.warn('[ai-review-worker] AI Reviewer user not found, attempting to seed')
      user = await ensureAiReviewerUser(prisma)
    }
    cachedReviewerUserId = user.id
    return user.id
  } catch (err) {
    console.error('[ai-review-worker] Failed to resolve AI Reviewer user:', err)
    return null
  }
}

// Override for tests.
type ClaudeClientFn = (
  params: AiReviewParams,
  content: ExtractedContent,
  filename: string
) => Promise<ClaudeReviewResult>

let claudeClientOverride: ClaudeClientFn | null = null

export function __setClaudeClientForTests(fn: ClaudeClientFn | null): void {
  claudeClientOverride = fn
}

// Single-concurrency in-process queue using a promise chain.
let queueTail: Promise<void> = Promise.resolve()
// Track pending review row IDs to avoid double-processing.
const inFlightIds = new Set<string>()

async function processJob(reviewId: string): Promise<void> {
  try {
    await runReview(reviewId)
  } catch (err) {
    console.error('[ai-review-worker] Unhandled error in processJob', reviewId, err)
  } finally {
    inFlightIds.delete(reviewId)
  }
}

async function fetchAndExtract(artifact: {
  storageKey: string
  mimeType: string
  filename: string
}): Promise<{ content: ExtractedContent } | { skipped: string }> {
  let bytes: Buffer
  try {
    const storage = getStorageDriver()
    const stream = await storage.getStream(artifact.storageKey)
    bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
  } catch {
    return { skipped: 'Artifact deleted before review' }
  }

  const content = await extractContent(bytes, artifact.mimeType, artifact.filename)
  return { content }
}

async function getContentForDescriptionReview(
  cardId: string
): Promise<{ content: ExtractedContent } | { skipped: string }> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { description: true },
  })
  if (!card) return { skipped: 'Card deleted before review' }
  const desc = card.description?.trim() ?? ''
  if (!desc) return { skipped: 'No description to review' }
  const text = desc.slice(0, PDF_SIZE_CAP)
  return { content: { kind: 'text', text } }
}

async function postReviewComment(
  reviewerUserId: string,
  cardId: string,
  subject: string,
  output: string
): Promise<void> {
  await prisma.comment.create({
    data: {
      cardId,
      userId: reviewerUserId,
      content: `**AI review of ${subject}:**\n\n${output}`,
    },
  })
}

async function runReview(reviewId: string): Promise<void> {
  const now = () => new Date()

  await prisma.aiReview.update({
    where: { id: reviewId },
    data: { status: 'running', startedAt: now() },
  })

  const review = await prisma.aiReview.findUnique({
    where: { id: reviewId },
    include: { artifact: true },
  })

  if (!review) {
    console.warn('[ai-review-worker] Review row disappeared mid-run:', reviewId)
    return
  }

  const isDescriptionReview = review.artifactId === null

  let fetchResult: { content: ExtractedContent } | { skipped: string }

  if (isDescriptionReview) {
    fetchResult = await getContentForDescriptionReview(review.cardId)
  } else {
    const artifact = review.artifact
    if (!artifact) {
      await prisma.aiReview.update({
        where: { id: reviewId },
        data: { status: 'skipped', errorMessage: 'Artifact deleted before review' },
      })
      return
    }
    fetchResult = await fetchAndExtract(artifact)
  }

  if ('skipped' in fetchResult) {
    await prisma.aiReview.update({
      where: { id: reviewId },
      data: { status: 'skipped', errorMessage: fetchResult.skipped },
    })
    return
  }

  const { content } = fetchResult

  if (content.kind === 'empty') {
    await prisma.aiReview.update({
      where: { id: reviewId },
      data: { status: 'skipped', errorMessage: 'No extractable content' },
    })
    return
  }

  const params: AiReviewParams = {
    model: review.model,
    rubric: review.rubricSnapshot,
    customInstructions: review.instructions ?? undefined,
  }

  const filename = isDescriptionReview
    ? 'card description'
    : (review.artifact?.filename ?? 'unknown')

  let result: ClaudeReviewResult
  try {
    result = await (claudeClientOverride ?? runClaudeReview)(params, content, filename)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.aiReview.update({
      where: { id: reviewId },
      data: {
        status: 'failed',
        errorMessage: msg.slice(0, 1000),
        finishedAt: now(),
      },
    })
    return
  }

  await prisma.aiReview.update({
    where: { id: reviewId },
    data: {
      status: 'done',
      output: result.output,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      finishedAt: now(),
    },
  })

  // For artifact reviews: verify artifact still exists before posting comment (E14)
  if (!isDescriptionReview) {
    const stillExists = await prisma.artifact.findUnique({ where: { id: review.artifactId! } })
    if (!stillExists) return
  }

  const reviewerUserId = await getReviewerUserId()
  if (!reviewerUserId) {
    console.warn('[ai-review-worker] Could not post comment: reviewer user id unavailable')
    return
  }

  // review.cardId is always set. Fall back to artifact.cardId for backward-compat with
  // test fixtures that mock the row without a top-level cardId field.
  const commentCardId = review.cardId ?? review.artifact?.cardId
  if (!commentCardId) {
    console.warn('[ai-review-worker] Could not resolve cardId for comment posting')
    return
  }

  const subject = isDescriptionReview ? 'card description' : (review.artifact?.filename ?? 'unknown')
  await postReviewComment(reviewerUserId, commentCardId, subject, result.output)
}

/**
 * Enqueues a new AI review for the given artifact.
 * Creates an AiReview row (or marks failed immediately if params are unavailable).
 * Returns false without creating a row if a pending or running review already exists.
 */
export async function enqueueAiReview(artifactId: string): Promise<boolean> {
  const artifact = await prisma.artifact.findUnique({
    where: { id: artifactId },
    select: { id: true, cardId: true },
  })
  if (!artifact) return false

  const existing = await prisma.aiReview.findFirst({
    where: { artifactId, status: { in: ['pending', 'running'] } },
    select: { id: true },
  })
  if (existing) return false

  const params = await resolveEffectiveAiReviewParams(prisma, artifact.cardId)

  if (!params) {
    await prisma.aiReview.create({
      data: {
        artifactId,
        cardId: artifact.cardId,
        status: 'failed',
        model: 'unknown',
        rubricSnapshot: '',
        errorMessage: 'No review params configured',
      },
    })
    return true
  }

  const review = await prisma.aiReview.create({
    data: {
      artifactId,
      cardId: artifact.cardId,
      status: 'pending',
      model: params.model,
      rubricSnapshot: params.rubric,
      instructions: params.customInstructions ?? null,
    },
  })

  if (inFlightIds.has(review.id)) return true
  inFlightIds.add(review.id)
  queueTail = queueTail.then(() => processJob(review.id))
  return true
}

/**
 * Enqueues a description-only AI review for the given card.
 * Returns false without creating a row if a pending or running description review already exists.
 * Returns false if the card does not exist.
 * Creates a failed row and returns true if params are not configured.
 */
export async function enqueueCardDescriptionReview(cardId: string): Promise<boolean> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { id: true },
  })
  if (!card) return false

  const existing = await prisma.aiReview.findFirst({
    where: { cardId, artifactId: null, status: { in: ['pending', 'running'] } },
    select: { id: true },
  })
  if (existing) return false

  const params = await resolveEffectiveAiReviewParams(prisma, cardId)

  if (!params) {
    await prisma.aiReview.create({
      data: {
        artifactId: null,
        cardId,
        status: 'failed',
        model: 'unknown',
        rubricSnapshot: '',
        errorMessage: 'No review params configured',
      },
    })
    return true
  }

  const review = await prisma.aiReview.create({
    data: {
      artifactId: null,
      cardId,
      status: 'pending',
      model: params.model,
      rubricSnapshot: params.rubric,
      instructions: params.customInstructions ?? null,
    },
  })

  if (inFlightIds.has(review.id)) return true
  inFlightIds.add(review.id)
  queueTail = queueTail.then(() => processJob(review.id))
  return true
}

/** For tests: returns when all queued jobs have drained. */
export async function flushForTests(): Promise<void> {
  await queueTail
}

/** For tests: resets the in-process queue without waiting for in-flight jobs. */
export function resetQueueForTests(): void {
  queueTail = Promise.resolve()
  inFlightIds.clear()
  cachedReviewerUserId = null
}

/**
 * Called at app boot. Resets any 'running' rows to 'pending' (they were
 * interrupted by a restart) and re-enqueues all pending rows.
 */
export async function bootstrapWorker(): Promise<void> {
  await prisma.aiReview.updateMany({
    where: { status: 'running' },
    data: { status: 'pending', startedAt: null },
  })

  const pendingRows = await prisma.aiReview.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  for (const row of pendingRows) {
    if (inFlightIds.has(row.id)) continue
    inFlightIds.add(row.id)
    queueTail = queueTail.then(() => processJob(row.id))
  }
}
