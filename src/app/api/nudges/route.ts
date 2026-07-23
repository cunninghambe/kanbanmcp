import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

// GET /api/nudges — pending nudges for the org, oldest first.
// requireSession + requireOrgRole(MEMBER). API-key callers may read (harmless).
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const nudges = await prisma.nudge.findMany({
      where: { orgId: session.orgId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    })

    // Resolve boardId from the card (null if the card is gone / has no cardId).
    const cardIds = [...new Set(nudges.map((n) => n.cardId).filter((id): id is string => !!id))]
    const cards = cardIds.length
      ? await prisma.card.findMany({
          where: { id: { in: cardIds }, board: { orgId: session.orgId } },
          select: { id: true, boardId: true },
        })
      : []
    const boardIdByCard = new Map(cards.map((c) => [c.id, c.boardId]))

    return NextResponse.json({
      nudges: nudges.map((n) => ({
        id: n.id,
        title: n.title,
        summary: n.summary,
        fromLabel: n.fromLabel,
        permalink: n.permalink,
        cardId: n.cardId,
        boardId: n.cardId ? (boardIdByCard.get(n.cardId) ?? null) : null,
        createdAt: n.createdAt,
      })),
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/nudges error:', err)
    return apiError(500, 'Internal server error')
  }
}
