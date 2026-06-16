import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

// GET /api/changesets?status=pending&hudSessionId=... — list ChangeSets for the org.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status') ?? undefined
    const hudSessionId = searchParams.get('hudSessionId') ?? undefined

    const changeSets = await prisma.changeSet.findMany({
      where: {
        orgId: session.orgId,
        ...(status ? { status } : {}),
        ...(hudSessionId ? { hudSessionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { _count: { select: { items: true } } },
    })

    return NextResponse.json({
      changeSets: changeSets.map((cs) => ({
        id: cs.id,
        status: cs.status,
        summary: cs.summary,
        boardId: cs.boardId,
        hudSessionId: cs.hudSessionId,
        dispatchId: cs.dispatchId,
        itemCount: cs._count.items,
        createdById: cs.createdById,
        createdAt: cs.createdAt,
      })),
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/changesets error:', err)
    return apiError(500, 'Internal server error')
  }
}
