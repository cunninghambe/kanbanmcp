import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { Card, HudEntry } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { logActivity } from '@/lib/agent-activity'

const convertSchema = z.object({
  columnId: z.string().optional(), // default: leftmost column of the session board
})

const TITLE_MAX = 200

// POST /api/hud/entries/[entryId]/card — one-click convert an action entry
// into a real card on the session's board. Human session only. Allowed on
// ended sessions too (post-meeting cleanup, unlike other entry mutations).
export async function POST(req: NextRequest, ctx: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'Converting an entry to a card requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const entry = await prisma.hudEntry.findFirst({
      where: { id: entryId, orgId: session.orgId },
      include: { hudSession: { select: { boardId: true } } },
    })
    if (!entry) return apiError(404, 'Entry not found')
    if (entry.kind !== 'action') return apiError(400, 'Only action entries can be converted to a card')
    const boardId = entry.hudSession.boardId
    if (!boardId) return apiError(409, 'Attach a board to create cards')
    if (entry.cardId) return apiError(409, 'Card already created for this entry')

    const parsed = convertSchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    const column = await resolveTargetColumn(boardId, parsed.data.columnId)
    if (!column.ok) return apiError(column.status, column.message)

    const result = await convertEntryToCard(entry, boardId, column.columnId, session.userId)
    if (!result) return apiError(409, 'Card already created for this entry')

    logActivity(session.orgId, session.userId, 'capture_action_card', 'card', result.card.id, {
      hudSessionId: entry.hudSessionId,
      entryId: entry.id,
    }).catch(() => {})

    return NextResponse.json({ entry: result.entry, card: result.card }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/hud/entries/[entryId]/card error:', err)
    return apiError(500, 'Internal server error')
  }
}

type ColumnResolution = { ok: true; columnId: string } | { ok: false; status: 400 | 409; message: string }

/** A requested columnId must belong to the board; omitted defaults to the leftmost column. */
async function resolveTargetColumn(boardId: string, columnId: string | undefined): Promise<ColumnResolution> {
  if (columnId) {
    const column = await prisma.column.findFirst({ where: { id: columnId, boardId } })
    if (!column) return { ok: false, status: 400, message: 'columnId must belong to the session board' }
    return { ok: true, columnId: column.id }
  }
  const leftmost = await prisma.column.findFirst({ where: { boardId }, orderBy: { position: 'asc' } })
  if (!leftmost) return { ok: false, status: 409, message: 'Board has no columns' }
  return { ok: true, columnId: leftmost.id }
}

type ConvertibleEntry = Pick<HudEntry, 'id' | 'text' | 'assigneeId' | 'dueDate'>

/**
 * Creates the card and links it to the entry in one transaction. Re-checks
 * cardId inside the transaction (not just the route's pre-check) so a
 * concurrent convert of the same entry can't create two cards; returns null
 * when that race is detected.
 */
async function convertEntryToCard(
  entry: ConvertibleEntry,
  boardId: string,
  columnId: string,
  createdById: string
): Promise<{ card: Card; entry: HudEntry } | null> {
  const title = entry.text.length > TITLE_MAX ? entry.text.slice(0, TITLE_MAX) : entry.text
  const description = entry.text.length > TITLE_MAX ? entry.text : undefined

  return prisma.$transaction(async (tx) => {
    const fresh = await tx.hudEntry.findUnique({ where: { id: entry.id }, select: { cardId: true } })
    if (fresh?.cardId) return null

    const agg = await tx.card.aggregate({ where: { columnId }, _max: { position: true } })
    const card = await tx.card.create({
      data: {
        title,
        description,
        columnId,
        boardId,
        assigneeId: entry.assigneeId,
        dueDate: entry.dueDate,
        createdById,
        position: (agg._max.position ?? 0) + 1,
      },
    })
    const updatedEntry = await tx.hudEntry.update({ where: { id: entry.id }, data: { cardId: card.id } })
    return { card, entry: updatedEntry }
  })
}
