// POST /api/planner/items — the quick-add to-do (spec §5.2).

import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiError, requireOrgRole, requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import { PLANNER_PRIORITIES, toPlannerItemDTO } from '@/lib/planner/types'

const createSchema = z.object({
  title: z.string().min(1).max(500),
  summary: z.string().max(2000).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  priority: z.enum(PLANNER_PRIORITIES).optional(),
})

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'The planner requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json().catch(() => null)
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 }
      )
    }
    const { title, summary, dueAt, priority } = parsed.data

    const item = await prisma.plannerItem.create({
      data: {
        orgId: session.orgId,
        userId: session.userId,
        source: 'manual',
        sourceKey: `manual:${randomUUID()}`,
        title,
        summary: summary ?? null,
        url: null,
        priority: priority ?? 'none',
        dueAt: dueAt ? new Date(dueAt) : null,
        status: 'open',
        payload: '{}',
      },
    })
    return NextResponse.json({ item: toPlannerItemDTO(item) }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/planner/items error:', err)
    return apiError(500, 'Internal server error')
  }
}
