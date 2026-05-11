import { NextRequest, NextResponse } from 'next/server'
import { Readable } from 'node:stream'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { getStorageDriver } from '@/lib/storage'

/** Strips control characters and escapes quotes from a filename for Content-Disposition. */
function safeFilename(name: string): string {
  // Remove control characters (0x00–0x1F, 0x7F), then escape double-quotes.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f]/g, '').replace(/"/g, '\\"')
}

// GET /api/artifacts/[artifactId]/download
// Streams the artifact bytes to the client with appropriate headers.
export async function GET(
  req: NextRequest,
  { params }: { params: { artifactId: string } }
) {
  try {
    const session = await requireSession(req)

    const artifact = await prisma.artifact.findUnique({
      where: { id: params.artifactId },
      include: { card: { include: { board: { select: { orgId: true } } } } },
    })

    if (!artifact) return apiError(404, 'Artifact not found')
    if (artifact.card.board.orgId !== session.orgId) return apiError(403, 'Forbidden')

    await requireOrgRole(session, session.orgId, 'MEMBER')

    const storage = getStorageDriver()

    let nodeStream: Readable
    try {
      nodeStream = await storage.getStream(artifact.storageKey)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return apiError(410, 'Gone')
      throw err
    }

    const webStream = Readable.toWeb(nodeStream) as ReadableStream

    return new NextResponse(webStream, {
      headers: {
        'Content-Type': artifact.mimeType,
        'Content-Disposition': `attachment; filename="${safeFilename(artifact.filename)}"`,
        'Content-Length': String(artifact.sizeBytes),
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/artifacts/[artifactId]/download error:', err)
    return apiError(500, 'Internal server error')
  }
}
