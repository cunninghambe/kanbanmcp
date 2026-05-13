import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { getStorageDriver } from '@/lib/storage'

// DELETE /api/artifacts/[artifactId]
// Deletes an artifact. Only the uploader or an org admin may do this.
export async function DELETE(req: NextRequest, { params }: { params: { artifactId: string } }) {
  try {
    const session = await requireSession(req)

    const artifact = await prisma.artifact.findUnique({
      where: { id: params.artifactId },
      include: { card: { include: { board: { select: { orgId: true } } } } },
    })

    if (!artifact) return apiError(404, 'Artifact not found')
    if (artifact.card.board.orgId !== session.orgId) return apiError(404, 'Artifact not found')

    const isUploader = !session.isApiKeyAuth && session.userId === artifact.uploaderId

    let isAdmin = false
    try {
      await requireOrgRole(session, session.orgId, 'ADMIN')
      isAdmin = true
    } catch {
      // Not an admin — handled below
    }

    if (!isUploader && !isAdmin) {
      return apiError(403, 'Only the uploader or an org admin may delete this artifact')
    }

    // Delete AiReview rows then the artifact row in one transaction.
    // (Cascade handles it in the schema too, but explicit transaction guarantees
    // atomicity relative to the storage delete that follows.)
    await prisma.$transaction(async (tx) => {
      await tx.aiReview.deleteMany({ where: { artifactId: params.artifactId } })
      await tx.artifact.delete({ where: { id: params.artifactId } })
    })

    const storage = getStorageDriver()
    await storage.delete(artifact.storageKey).catch((err: unknown) => {
      // DB is the source of truth. Log the storage failure but return 204 anyway.
      console.error(
        'Storage delete failed after artifact DB row removed:',
        artifact.storageKey,
        err
      )
    })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('DELETE /api/artifacts/[artifactId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
