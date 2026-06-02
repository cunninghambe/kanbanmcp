import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'

type StatusResponse =
  | { connected: false }
  | {
      connected: true
      email: string
      scopes: string[]
      lastUsedAt: string | null
      expired: boolean
    }

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession(req)

    const cred = await prisma.googleCredential.findUnique({
      where: { userId: session.userId },
    })

    if (!cred) {
      return NextResponse.json({ connected: false } satisfies StatusResponse)
    }

    const expired = cred.accessToken === null && cred.accessTokenExpiresAt === null

    const body: StatusResponse = {
      connected: true,
      email: cred.googleEmail,
      scopes: cred.scopes.split(' ').filter(Boolean),
      lastUsedAt: cred.lastUsedAt?.toISOString() ?? null,
      expired,
    }

    return NextResponse.json(body)
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/me/google/status error:', err)
    return apiError(500, 'Internal server error')
  }
}
