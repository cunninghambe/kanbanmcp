import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { getStorageDriver } from '@/lib/storage'
import { MAX_ARTIFACT_BYTES, isAllowedMime, shapeArtifact } from '@/lib/artifacts'
import { enqueueAiReview } from '@/lib/ai-review/queue'

async function resolveCard(cardId: string, orgId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { board: { select: { orgId: true } } },
  })
  if (!card) throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  if (card.board.orgId !== orgId) throw NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return card
}

// POST /api/cards/[cardId]/artifacts
// Uploads a file as an artifact attached to the card.
export async function POST(
  req: NextRequest,
  { params }: { params: { cardId: string } }
) {
  try {
    const session = await requireSession(req)
    const card = await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    // For API key auth, resolve to the first org admin as the uploader.
    let uploaderId = session.userId
    if (session.isApiKeyAuth) {
      const orgMember = await prisma.orgMember.findFirst({
        where: { orgId: session.orgId },
        orderBy: { role: 'desc' },
        select: { userId: true },
      })
      if (!orgMember) return apiError(500, 'No org member found to associate upload with')
      uploaderId = orgMember.userId
    }

    const formData = await req.formData()
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
    const freshCard = await prisma.card.findUnique({ where: { id: params.cardId }, select: { aiAutoReview: true } })
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
export async function GET(
  req: NextRequest,
  { params }: { params: { cardId: string } }
) {
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
