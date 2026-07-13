import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { expireStaleChangeSets } from '@/lib/changesets'
import { describeChangeItems } from '@/lib/changesets-display'

// GET /api/changesets/[id] — ChangeSet with parsed items.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    await expireStaleChangeSets(prisma, session.orgId, new Date())

    const changeSet = await prisma.changeSet.findFirst({
      where: { id, orgId: session.orgId },
      include: { items: true },
    })
    if (!changeSet) return apiError(404, 'ChangeSet not found')

    const displayByItemId = new Map(
      (
        await describeChangeItems(
          prisma,
          session.orgId,
          changeSet.items.map((it) => ({ id: it.id, op: it.op, payload: it.payload, targetCardId: it.targetCardId }))
        )
      ).map((d) => [d.itemId, d.display])
    )

    return NextResponse.json({
      changeSet: {
        ...changeSet,
        items: changeSet.items.map((it) => ({
          ...it,
          payload: safeParse(it.payload),
          evidence: it.evidence ? safeParse(it.evidence) : null,
          resolution: it.resolution ? safeParse(it.resolution) : null,
          display: displayByItemId.get(it.id) ?? `${it.op} (unreadable payload)`,
        })),
      },
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/changesets/[id] error:', err)
    return apiError(500, 'Internal server error')
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
