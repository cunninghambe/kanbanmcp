import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'
import { revokeRefreshToken } from '@/lib/google/oauth'

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession(req)

    const cred = await prisma.googleCredential.findUnique({
      where: { userId: session.userId },
    })

    if (!cred) {
      return new NextResponse(null, { status: 204 })
    }

    await revokeRefreshToken(session.userId).catch(() => {
      // Best-effort: ignore network failures
    })

    await prisma.googleCredential.delete({ where: { userId: session.userId } })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('DELETE /api/me/google/disconnect error:', err)
    return apiError(500, 'Internal server error')
  }
}
