import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { shapeArtifact } from '@/lib/artifacts'
import { enqueueAiReview } from '@/lib/ai-review/queue'
import { parseDriveUrl, getFileMeta, listFolderRecursive } from '@/lib/google/drive'
import { mapMimeToSource, buildStorageKey } from '@/lib/google/source-mapping'
import { DriveForbiddenError, DriveNotFoundError, DriveTrashedError, GoogleHttpError } from '@/lib/google/errors'
import type { Artifact, User, AiReview } from '@prisma/client'

const BodySchema = z.object({ url: z.string() })

type ArtifactWithRelations = Artifact & { uploader: User; reviews: AiReview[] }

const FOLDER_CAPS = { maxDepth: 3, maxCount: 50, maxFileBytes: 5_242_880 } as const
const INCLUDE_RELATIONS = { uploader: true, reviews: true } as const

type AttachResult = { response: NextResponse; reviewableIds: string[] }

async function resolveCard(cardId: string, orgId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { board: { select: { orgId: true } } },
  })
  if (!card || card.board.orgId !== orgId) {
    throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }
  return card
}

async function resolveUploaderId(session: Awaited<ReturnType<typeof requireSession>>): Promise<string> {
  if (!session.isApiKeyAuth) return session.userId
  const admin = await prisma.orgMember.findFirst({
    where: { orgId: session.orgId, role: 'ADMIN' },
    orderBy: { userId: 'asc' },
    select: { userId: true },
  })
  if (!admin) throw apiError(500, 'No org admin found to attribute upload to')
  return admin.userId
}

function mapDriveError(err: unknown, fileId: string): NextResponse {
  if (err instanceof DriveTrashedError) return NextResponse.json({ error: 'TRASHED', fileId }, { status: 404 })
  if (err instanceof DriveForbiddenError) return NextResponse.json({ error: 'FORBIDDEN', fileId }, { status: 403 })
  if (err instanceof DriveNotFoundError) return NextResponse.json({ error: 'NOT_FOUND', fileId }, { status: 404 })
  if (err instanceof GoogleHttpError) return NextResponse.json({ error: 'GOOGLE_HTTP_ERROR', fileId, status: err.status }, { status: 502 })
  throw err
}

async function touchLastUsedAt(uploaderId: string): Promise<void> {
  await prisma.googleCredential.update({
    where: { userId: uploaderId },
    data: { lastUsedAt: new Date() },
  }).catch((err: unknown) => console.warn('Failed to update lastUsedAt:', err))
}

async function attachFile(cardId: string, uploaderId: string, fileId: string): Promise<AttachResult> {
  let meta
  try {
    meta = await getFileMeta(uploaderId, fileId)
  } catch (err) {
    return { response: mapDriveError(err, fileId), reviewableIds: [] }
  }

  const source = mapMimeToSource(meta.mimeType)
  if (!source) return { response: NextResponse.json({ error: 'UNSUPPORTED_TYPE' }, { status: 409 }), reviewableIds: [] }

  const row = await prisma.artifact.create({
    data: {
      cardId,
      uploaderId,
      filename: meta.name,
      mimeType: meta.mimeType,
      sizeBytes: 0,
      source,
      storageKey: buildStorageKey(source, fileId),
      parentArtifactId: null,
    },
    include: INCLUDE_RELATIONS,
  }) as ArtifactWithRelations

  return {
    response: NextResponse.json({ artifact: shapeArtifact(row) }, { status: 201 }),
    reviewableIds: [row.id],
  }
}

async function attachFolder(cardId: string, uploaderId: string, folderId: string): Promise<AttachResult> {
  let meta
  try {
    meta = await getFileMeta(uploaderId, folderId)
  } catch (err) {
    return { response: mapDriveError(err, folderId), reviewableIds: [] }
  }

  if (meta.mimeType !== 'application/vnd.google-apps.folder') {
    return { response: NextResponse.json({ error: 'UNSUPPORTED_TYPE' }, { status: 409 }), reviewableIds: [] }
  }

  const enumResult = await listFolderRecursive(uploaderId, folderId, FOLDER_CAPS)

  // Special case per M4.02 review: a single rejected entry matching the root folderId
  // means Drive returned 403 on the root — surface as 403, not a confusing 201 with empty children.
  if (enumResult.files.length === 0 && enumResult.rejected.length === 1 && enumResult.rejected[0].id === folderId) {
    return { response: NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 }), reviewableIds: [] }
  }

  const { folderRow, fileRows } = await prisma.$transaction(async (tx) => {
    const folder = await tx.artifact.create({
      data: {
        cardId,
        uploaderId,
        filename: meta.name,
        mimeType: meta.mimeType,
        sizeBytes: 0,
        source: 'GOOGLE_FOLDER',
        storageKey: buildStorageKey('GOOGLE_FOLDER', folderId),
        parentArtifactId: null,
      },
      include: INCLUDE_RELATIONS,
    }) as ArtifactWithRelations

    const children: ArtifactWithRelations[] = []
    for (const file of enumResult.files) {
      const childSource = mapMimeToSource(file.mimeType)
      if (!childSource) continue
      const child = await tx.artifact.create({
        data: {
          cardId,
          uploaderId,
          filename: file.name,
          mimeType: file.mimeType,
          sizeBytes: 0,
          source: childSource,
          storageKey: buildStorageKey(childSource, file.id),
          parentArtifactId: folder.id,
        },
        include: INCLUDE_RELATIONS,
      }) as ArtifactWithRelations
      children.push(child)
    }

    return { folderRow: folder, fileRows: children }
  })

  const folderShaped = shapeArtifact(folderRow)
  const filesShaped = fileRows.map(shapeArtifact)

  if (enumResult.rejected.length > 0) {
    return {
      response: NextResponse.json(
        { error: 'PARTIAL_FOLDER', folder: folderShaped, files: filesShaped, rejected: enumResult.rejected },
        { status: 422 },
      ),
      reviewableIds: fileRows.map((r) => r.id),
    }
  }

  return {
    response: NextResponse.json({ artifact: folderShaped, expandedArtifacts: filesShaped }, { status: 201 }),
    reviewableIds: fileRows.map((r) => r.id),
  }
}

// POST /api/cards/[cardId]/artifacts/google
export async function POST(req: NextRequest, ctx: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await ctx.params
  try {
    const session = await requireSession(req)
    const card = await resolveCard(cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const uploaderId = await resolveUploaderId(session)

    const credential = await prisma.googleCredential.findUnique({ where: { userId: uploaderId } })
    if (!credential) return NextResponse.json({ error: 'NOT_CONNECTED' }, { status: 401 })

    const bodyResult = BodySchema.safeParse(await req.json())
    if (!bodyResult.success) return NextResponse.json({ error: 'INVALID_URL' }, { status: 400 })

    const parsed = parseDriveUrl(bodyResult.data.url)
    if (!parsed) return NextResponse.json({ error: 'INVALID_URL' }, { status: 400 })

    const { response, reviewableIds } = parsed.kind === 'file'
      ? await attachFile(cardId, uploaderId, parsed.id)
      : await attachFolder(cardId, uploaderId, parsed.id)

    if (response.status === 201 || response.status === 422) {
      void touchLastUsedAt(uploaderId)
      if (card.aiAutoReview) {
        for (const id of reviewableIds) {
          await enqueueAiReview(id)
        }
      }
    }

    return response
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/cards/[cardId]/artifacts/google error:', err)
    return apiError(500, 'Internal server error')
  }
}
