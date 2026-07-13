import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { expireStaleChangeSets } from '@/lib/changesets'

// GET /api/changesets?status=pending&hudSessionId=... — list ChangeSets for the org.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    await expireStaleChangeSets(prisma, session.orgId, new Date())

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

    const hudSessionTitleById = await hudSessionTitles(changeSets.map((cs) => cs.hudSessionId))

    return NextResponse.json({
      changeSets: changeSets.map((cs) => ({
        id: cs.id,
        status: cs.status,
        summary: cs.summary,
        boardId: cs.boardId,
        hudSessionId: cs.hudSessionId,
        hudSessionTitle: cs.hudSessionId ? (hudSessionTitleById.get(cs.hudSessionId) ?? null) : null,
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

/** ChangeSet.hudSessionId is a plain string column (no Prisma relation) — batch-fetch titles. */
async function hudSessionTitles(hudSessionIds: Array<string | null>): Promise<Map<string, string | null>> {
  const ids = [...new Set(hudSessionIds.filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  const sessions = await prisma.hudSession.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } })
  return new Map(sessions.map((s) => [s.id, s.title]))
}
