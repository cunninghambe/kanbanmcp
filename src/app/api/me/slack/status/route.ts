import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'

type StatusResponse =
  | { connected: false }
  | {
      connected: true
      teamName: string
      teamId: string
      slackUserId: string
      scopes: string[]
      lastUsedAt: string | null
    }

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession(req)

    const cred = await prisma.slackCredential.findUnique({
      where: { userId: session.userId },
    })

    if (!cred) {
      return NextResponse.json({ connected: false } satisfies StatusResponse)
    }

    // The ciphertext never leaves the server.
    const body: StatusResponse = {
      connected: true,
      teamName: cred.teamName,
      teamId: cred.teamId,
      slackUserId: cred.slackUserId,
      scopes: cred.scopes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      lastUsedAt: cred.lastUsedAt?.toISOString() ?? null,
    }

    return NextResponse.json(body)
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/me/slack/status error:', err)
    return apiError(500, 'Internal server error')
  }
}
