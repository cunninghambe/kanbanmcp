import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const decisionsSchema = z.object({
  decisions: z
    .array(
      z.object({
        itemId: z.string().min(1),
        decision: z.enum(['approved', 'rejected', 'retargeted']),
        // For retargeted items, the chosen target card.
        targetCardId: z.string().optional(),
      })
    )
    .min(1),
})

// POST /api/changesets/[id]/decisions — record per-item review decisions.
// HUMAN SESSION ONLY: agents propose, only humans approve (MEETINGCOPILOTSPEC §4.5).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) {
      return apiError(403, 'Approving changes requires a human session; agents may only propose')
    }
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const changeSet = await prisma.changeSet.findFirst({
      where: { id, orgId: session.orgId },
      include: { items: { select: { id: true } } },
    })
    if (!changeSet) return apiError(404, 'ChangeSet not found')

    const parsed = decisionsSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    const validIds = new Set(changeSet.items.map((i) => i.id))
    for (const d of parsed.data.decisions) {
      if (!validIds.has(d.itemId)) return apiError(400, `Item ${d.itemId} is not part of this ChangeSet`)
    }

    await prisma.$transaction(
      parsed.data.decisions.map((d) =>
        prisma.changeItem.update({
          where: { id: d.itemId },
          data: {
            decision: d.decision,
            decidedById: session.userId,
            ...(d.targetCardId ? { targetCardId: d.targetCardId } : {}),
          },
        })
      )
    )

    let updated = await prisma.changeSet.findUnique({ where: { id }, include: { items: true } })
    // Mixed/partial decisions leave status untouched — apply already manages
    // applied/partially_applied. Only a unanimous reject flips the set.
    if (updated && updated.items.every((it) => it.decision === 'rejected')) {
      updated = await prisma.changeSet.update({
        where: { id },
        data: { status: 'rejected' },
        include: { items: true },
      })
    }
    return NextResponse.json({ changeSet: updated })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/changesets/[id]/decisions error:', err)
    return apiError(500, 'Internal server error')
  }
}
