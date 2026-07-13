import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { buildDigest } from '@/lib/host-hud/digest'
import { resolveMemberNames } from '@/lib/host-hud/members'
import { expireStaleChangeSets } from '@/lib/changesets'

// GET /api/hud/[id]/digest
// Computed end-of-meeting digest (stats + markdown) for the wrap-up view.
// No isApiKeyAuth gate — same authz pattern as /api/changesets, whose lazy
// expiry sweep this route also runs (an idempotent, org-scoped write, not a
// board mutation). Works on live sessions too — the chair can peek
// mid-meeting (digest.stats.durationMs is null until the session ends).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const hud = await prisma.hudSession.findFirst({
      where: { id, orgId: session.orgId },
      select: { id: true, title: true, startedAt: true, endedAt: true, boardId: true },
    })
    if (!hud) return apiError(404, 'HUD session not found')

    // Same lazy sweep GET /api/changesets runs, so the digest's own
    // proposals/proposalsPending stats never disagree with the pending list
    // a chair sees on a stale-reopened session.
    await expireStaleChangeSets(prisma, session.orgId, new Date())

    const [boardName, entries, dispatches, changeSets] = await Promise.all([
      resolveBoardName(session.orgId, hud.boardId),
      prisma.hudEntry.findMany({
        where: { hudSessionId: id },
        orderBy: [{ kind: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.agentDispatch.findMany({
        where: { hudSessionId: id },
        orderBy: { createdAt: 'asc' },
        select: { target: true, question: true, status: true, answer: true },
      }),
      prisma.changeSet.findMany({
        where: { hudSessionId: id },
        include: { _count: { select: { items: true } } },
      }),
    ])

    const assigneeIds = entries.map((e) => e.assigneeId).filter((v): v is string => v !== null)
    const memberNames = await resolveMemberNames(prisma, session.orgId, assigneeIds)

    const digest = buildDigest({
      session: { id: hud.id, title: hud.title, startedAt: hud.startedAt, endedAt: hud.endedAt },
      boardName,
      entries,
      dispatches,
      changeSets: changeSets.map((cs) => ({
        id: cs.id,
        status: cs.status,
        summary: cs.summary,
        itemCount: cs._count.items,
      })),
      memberNames,
    })

    return NextResponse.json({ digest })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/hud/[id]/digest error:', err)
    return apiError(500, 'Internal server error')
  }
}

async function resolveBoardName(orgId: string, boardId: string | null): Promise<string | null> {
  if (!boardId) return null
  const board = await prisma.board.findFirst({ where: { id: boardId, orgId }, select: { name: true } })
  return board?.name ?? null
}
