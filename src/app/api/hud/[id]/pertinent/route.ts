import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const STALL_DAYS = 3
const TERMINAL_COLUMNS = new Set(['done', 'closed', 'shipped', 'archived'])

type PertinentCard = {
  id: string
  title: string
  priority: string
  columnName: string
  dueDate: string | null
  updatedAt: string
  ageDays: number
}

// GET /api/hud/[id]/pertinent
// Board-derived situational context for the HUD's pertinent rail: overdue,
// stalled, and aging cards. Purely from board state — no inference (mirrors the
// spec's ledger⋈board-diff philosophy, board-only variant).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const hud = await prisma.hudSession.findFirst({
      where: { id, orgId: session.orgId },
      select: { id: true, boardId: true },
    })
    if (!hud) return apiError(404, 'HUD session not found')

    if (!hud.boardId) {
      return NextResponse.json({ board: null, overdue: [], stalled: [], aging: [], counts: zero() })
    }

    const board = await prisma.board.findFirst({
      where: { id: hud.boardId, orgId: session.orgId },
      include: {
        columns: { include: { cards: { include: { column: { select: { name: true } } } } } },
      },
    })
    if (!board) {
      return NextResponse.json({ board: null, overdue: [], stalled: [], aging: [], counts: zero() })
    }

    const now = Date.now()
    const stallCutoff = now - STALL_DAYS * 86_400_000
    const cards = board.columns.flatMap((c) => c.cards)

    const overdue: PertinentCard[] = []
    const stalled: PertinentCard[] = []
    const aging: PertinentCard[] = []

    for (const card of cards) {
      const colName = card.column.name
      if (TERMINAL_COLUMNS.has(colName.toLowerCase())) continue

      const shaped: PertinentCard = {
        id: card.id,
        title: card.title,
        priority: card.priority,
        columnName: colName,
        dueDate: card.dueDate ? card.dueDate.toISOString() : null,
        updatedAt: card.updatedAt.toISOString(),
        ageDays: Math.floor((now - card.updatedAt.getTime()) / 86_400_000),
      }

      if (card.dueDate && card.dueDate.getTime() < now) {
        overdue.push(shaped)
      } else if (card.updatedAt.getTime() < stallCutoff) {
        stalled.push(shaped)
      }
      if (shaped.ageDays >= STALL_DAYS) aging.push(shaped)
    }

    overdue.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
    stalled.sort((a, b) => b.ageDays - a.ageDays)
    aging.sort((a, b) => b.ageDays - a.ageDays)

    return NextResponse.json({
      board: { id: board.id, name: board.name },
      overdue,
      stalled,
      aging: aging.slice(0, 8),
      counts: { overdue: overdue.length, stalled: stalled.length, aging: aging.length, total: cards.length },
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/hud/[id]/pertinent error:', err)
    return apiError(500, 'Internal server error')
  }
}

function zero() {
  return { overdue: 0, stalled: 0, aging: 0, total: 0 }
}
