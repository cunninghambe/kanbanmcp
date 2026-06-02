import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { getStorageDriver } from '@/lib/storage'
import { MAX_ARTIFACT_BYTES, isAllowedMime, shapeArtifact } from '@/lib/artifacts'
import { enqueueAiReview } from '@/lib/ai-review/queue'

/**
 * Reads a request body stream into a single Buffer, aborting once the
 * cumulative byte count exceeds `maxBytes`.
 *
 * Returns `{ overLimit: true }` as soon as the cap is exceeded — WITHOUT
 * buffering the rest of the stream — so a chunked-encoded (no Content-Length)
 * payload cannot force unbounded in-memory buffering before formData() runs.
 * Returns `{ overLimit: false, bytes }` when the whole body fits within the cap.
 */
async function readBodyWithLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ overLimit: true } | { overLimit: false; bytes: Buffer }> {
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        // Stop pulling immediately; release the stream so the producer is not
        // kept buffering on our behalf.
        await reader.cancel().catch(() => {})
        return { overLimit: true }
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return { overLimit: false, bytes: Buffer.concat(chunks, total) }
}

async function resolveCard(cardId: string, orgId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { board: { select: { orgId: true } } },
  })
  if (!card) throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  if (card.board.orgId !== orgId) throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  return card
}

// POST /api/cards/[cardId]/artifacts
// Uploads a file as an artifact attached to the card.
export async function POST(req: NextRequest, ctx: { params: Promise<{ cardId: string }> }) {
  const params = await ctx.params
  try {
    const session = await requireSession(req)

    // Fast-path rejection when an honest Content-Length already exceeds the cap.
    const cl = req.headers.get('content-length')
    if (cl && parseInt(cl, 10) > MAX_ARTIFACT_BYTES) {
      return apiError(413, 'Payload Too Large')
    }

    const card = await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    // Enforce the size cap by counting ACTUAL bytes streamed off the wire.
    // The Content-Length header is advisory and bypassable via chunked
    // transfer-encoding, so we must not trust it (and must not treat a missing
    // Content-Length as "proceed"). Buffer the body ourselves, aborting with
    // 413 the moment the cap is exceeded — before calling formData(), which
    // would otherwise buffer the whole (possibly unbounded) payload in memory.
    if (!req.body) {
      return apiError(400, 'Missing request body')
    }
    const read = await readBodyWithLimit(req.body, MAX_ARTIFACT_BYTES)
    if (read.overLimit) {
      return apiError(413, 'Payload Too Large')
    }

    // Re-wrap the bounded bytes in a Request so the platform multipart parser
    // (formData) can decode the within-limit payload. Content-Type carries the
    // multipart boundary and must be preserved.
    const parseRequest = new Request(req.url, {
      method: 'POST',
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
      // Buffer → Uint8Array: a Node Buffer works at runtime but is not a typed
      // BodyInit; Uint8Array is a valid BufferSource. Payload is already capped.
      body: new Uint8Array(read.bytes),
    })

    // For API key auth, resolve to the first org admin as the uploader.
    let uploaderId = session.userId
    if (session.isApiKeyAuth) {
      const orgAdmin = await prisma.orgMember.findFirst({
        where: { orgId: session.orgId, role: 'ADMIN' },
        orderBy: { userId: 'asc' },
        select: { userId: true },
      })
      if (!orgAdmin) return apiError(500, 'No org admin found to attribute upload to')
      uploaderId = orgAdmin.userId
    }

    const formData = await parseRequest.formData()
    const file = formData.get('file')

    if (!(file instanceof File)) return apiError(400, 'Missing file field')
    if (file.size > MAX_ARTIFACT_BYTES) return apiError(413, 'Payload Too Large')
    if (!isAllowedMime(file.type)) return apiError(415, 'Unsupported Media Type')

    // Create the DB row first to obtain the cuid, which becomes the storage key.
    // If the storage write fails, the row is deleted to roll back.
    // True atomicity between SQL and filesystem is not possible; if the rollback
    // also fails, we log loudly and the orphan row will have no backing file.
    const artifact = await prisma.artifact.create({
      data: {
        cardId: params.cardId,
        uploaderId,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        storageKey: 'pending', // overwritten below
        source: 'UPLOAD',
      },
    })

    const bytes = Buffer.from(await file.arrayBuffer())
    const storage = getStorageDriver()

    try {
      await storage.put(artifact.id, bytes, file.type)
    } catch (storageErr) {
      console.error('Storage write failed, rolling back artifact row:', storageErr)
      await prisma.artifact.delete({ where: { id: artifact.id } }).catch((rbErr: unknown) => {
        console.error('Artifact rollback failed — orphan row:', artifact.id, rbErr)
      })
      return apiError(500, 'Internal server error')
    }

    // Update storageKey to the artifact's cuid (path-traversal safe by design).
    const updated = await prisma.artifact.update({
      where: { id: artifact.id },
      data: { storageKey: artifact.id },
      include: {
        uploader: true,
        reviews: true,
      },
    })

    // Re-fetch the card to check aiAutoReview (card may not include this field from the initial resolve).
    const freshCard = await prisma.card.findUnique({
      where: { id: params.cardId },
      select: { aiAutoReview: true },
    })
    if (freshCard?.aiAutoReview) {
      await enqueueAiReview(artifact.id)
    }

    return NextResponse.json({ artifact: shapeArtifact(updated) }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/cards/[cardId]/artifacts error:', err)
    return apiError(500, 'Internal server error')
  }
}

// GET /api/cards/[cardId]/artifacts
// Lists all artifacts for the card, ordered by creation time descending.
export async function GET(req: NextRequest, ctx: { params: Promise<{ cardId: string }> }) {
  const params = await ctx.params
  try {
    const session = await requireSession(req)
    await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const artifacts = await prisma.artifact.findMany({
      where: { cardId: params.cardId },
      orderBy: { createdAt: 'desc' },
      include: {
        uploader: true,
        reviews: true,
      },
    })

    return NextResponse.json({ artifacts: artifacts.map(shapeArtifact) })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/cards/[cardId]/artifacts error:', err)
    return apiError(500, 'Internal server error')
  }
}
