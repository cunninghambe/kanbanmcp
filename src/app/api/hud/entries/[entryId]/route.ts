import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const patchEntrySchema = z
  .object({
    text: z.string().trim().min(1).max(2000).optional(),
    checked: z.boolean().optional(), // agenda only — sets/clears checkedAt server-side
    position: z.number().int().min(0).optional(),
    assigneeId: z.string().nullable().optional(),
    dueDate: z.string().datetime().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0)

interface EntryUpdateData {
  text?: string
  checkedAt?: Date | null
  position?: number
  assigneeId?: string | null
  dueDate?: Date | null
}

// PATCH /api/hud/entries/[entryId] — edit text/position/assignee/due date, or
// check off an agenda item. Human session only. Requires a live session,
// EXCEPT a checked-only patch on an agenda entry, which post-meeting cleanup
// also allows on an ended session.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'Editing a HUD entry requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const entry = await prisma.hudEntry.findFirst({
      where: { id: entryId, orgId: session.orgId },
      include: { hudSession: { select: { status: true } } },
    })
    if (!entry) return apiError(404, 'Entry not found')

    const parsed = patchEntrySchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    const fields = parsed.data
    const isCheckedOnlyAgendaPatch =
      entry.kind === 'agenda' && 'checked' in fields && Object.keys(fields).length === 1
    if (entry.hudSession.status !== 'live' && !isCheckedOnlyAgendaPatch) {
      return apiError(409, 'HUD session is not live')
    }

    const data: EntryUpdateData = {}
    if (fields.text !== undefined) data.text = fields.text
    if (fields.checked !== undefined) data.checkedAt = fields.checked ? new Date() : null
    if (fields.position !== undefined) data.position = fields.position
    if (fields.assigneeId !== undefined) data.assigneeId = fields.assigneeId
    if (fields.dueDate !== undefined) data.dueDate = fields.dueDate === null ? null : new Date(fields.dueDate)

    const updated = await prisma.hudEntry.update({ where: { id: entryId }, data })
    return NextResponse.json({ entry: updated })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('PATCH /api/hud/entries/[entryId] error:', err)
    return apiError(500, 'Internal server error')
  }
}

// DELETE /api/hud/entries/[entryId] — remove an entry. Human session only,
// live sessions only (no post-meeting exception, unlike agenda check-off).
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'Deleting a HUD entry requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const entry = await prisma.hudEntry.findFirst({
      where: { id: entryId, orgId: session.orgId },
      include: { hudSession: { select: { status: true } } },
    })
    if (!entry) return apiError(404, 'Entry not found')
    if (entry.hudSession.status !== 'live') return apiError(409, 'HUD session is not live')

    await prisma.hudEntry.delete({ where: { id: entryId } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('DELETE /api/hud/entries/[entryId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
