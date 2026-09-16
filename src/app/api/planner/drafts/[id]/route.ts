// PATCH / DELETE /api/planner/drafts/[id] — spec §5.6.
//
// Any edit to the title or body clears `pendingEmail`: a composed Gmail draft
// stops being sendable the moment the text on screen diverges from it.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiError, requireOrgRole, requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import { toPlannerDraftDTO } from '@/lib/planner/types'

const patchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    body: z.string().max(50_000).optional(),
  })
  .refine((data) => data.title !== undefined || data.body !== undefined, {
    message: 'title or body is required',
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

    const existing = await prisma.plannerDraft.findFirst({
      where: { id, userId: session.userId, orgId: session.orgId },
      select: { id: true },
    })
    if (!existing) return apiError(404, 'Draft not found')

    const draft = await prisma.plannerDraft.update({
      where: { id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
        pendingEmail: null,
      },
    })
    return NextResponse.json({ draft: toPlannerDraftDTO(draft) })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('PATCH /api/planner/drafts/[id] error:', err)
    return apiError(500, 'Internal server error')
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'The planner requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const existing = await prisma.plannerDraft.findFirst({
      where: { id, userId: session.userId, orgId: session.orgId },
      select: { id: true },
    })
    if (!existing) return apiError(404, 'Draft not found')

    await prisma.plannerDraft.delete({ where: { id } })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('DELETE /api/planner/drafts/[id] error:', err)
    return apiError(500, 'Internal server error')
  }
}
