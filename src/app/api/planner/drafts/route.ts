// GET / POST /api/planner/drafts — the composer's documents (spec §5.6).

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiError, requireOrgRole, requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import { toPlannerDraftDTO } from '@/lib/planner/types'

const createSchema = z.object({
  itemId: z.string().min(1).optional(),
  title: z.string().min(1).max(300),
  body: z.string().max(50_000).optional(),
})

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'The planner requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const itemId = new URL(req.url).searchParams.get('itemId')
    const drafts = await prisma.plannerDraft.findMany({
      where: {
        userId: session.userId,
        orgId: session.orgId,
        ...(itemId ? { itemId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return NextResponse.json({ drafts: drafts.map(toPlannerDraftDTO) })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/planner/drafts error:', err)
    return apiError(500, 'Internal server error')
  }
}

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
    const { itemId, title } = parsed.data

    if (itemId) {
      const item = await prisma.plannerItem.findFirst({
        where: { id: itemId, userId: session.userId, orgId: session.orgId },
        select: { id: true },
      })
      if (!item) return apiError(404, 'Item not found')
    }

    const draft = await prisma.plannerDraft.create({
      data: {
        orgId: session.orgId,
        userId: session.userId,
        itemId: itemId ?? null,
        title,
        body: parsed.data.body ?? '',
        status: 'draft',
      },
    })
    return NextResponse.json({ draft: toPlannerDraftDTO(draft) }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/planner/drafts error:', err)
    return apiError(500, 'Internal server error')
  }
}
