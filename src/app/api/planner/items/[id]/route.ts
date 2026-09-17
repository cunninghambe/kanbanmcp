// PATCH / DELETE /api/planner/items/[id] — spec §5.3, §5.4.
//
// Another user's item is a 404, never a 403: the planner never confirms that
// someone else's row exists.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiError, requireOrgRole, requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import { applyItemAction } from '@/lib/planner/service'
import { PLANNER_ACTIONS } from '@/lib/planner/types'

const patchSchema = z
  .object({
    action: z.enum(PLANNER_ACTIONS),
    snoozedUntil: z.string().datetime({ offset: true }).optional(),
    writeThrough: z.boolean().optional(),
  })
  .refine((data) => data.action !== 'snooze' || data.snoozedUntil !== undefined, {
    message: 'snoozedUntil is required when action is snooze',
    path: ['snoozedUntil'],
  })

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'The planner requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json().catch(() => null)
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 }
      )
    }
    const { action, writeThrough } = parsed.data

    const now = new Date()
    let snoozedUntil: Date | undefined
    if (action === 'snooze') {
      snoozedUntil = new Date(parsed.data.snoozedUntil as string)
      if (snoozedUntil.getTime() <= now.getTime()) {
        return NextResponse.json(
          {
            error: 'Validation failed',
            issues: [{ path: ['snoozedUntil'], message: 'snoozedUntil must be in the future' }],
          },
          { status: 400 }
        )
      }
    }

    const result = await applyItemAction(prisma, {
      session,
      itemId: id,
      action,
      snoozedUntil,
      writeThrough: writeThrough ?? true,
      now,
    })
    if (!result) return apiError(404, 'Item not found')

    // A 200 may carry failed write-through entries: the status change stands.
    return NextResponse.json({ item: result.item, writeThrough: result.writeThrough })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('PATCH /api/planner/items/[id] error:', err)
    return apiError(500, 'Internal server error')
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'The planner requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const item = await prisma.plannerItem.findFirst({
      where: { id, userId: session.userId, orgId: session.orgId },
    })
    if (!item) return apiError(404, 'Item not found')
    if (item.source !== 'manual') {
      return apiError(400, 'Only your own to-dos can be deleted; dismiss instead')
    }

    await prisma.plannerItem.delete({ where: { id } })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('DELETE /api/planner/items/[id] error:', err)
    return apiError(500, 'Internal server error')
  }
}
