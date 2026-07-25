import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { isInboxOwner } from '@/lib/inbox-agent'

// GET /api/nudges — pending nudges for the mailbox owner, oldest first.
//
// Nudges carry subject lines and sender names lifted straight out of a personal
// inbox, so org membership is not sufficient to read them: a nudge feed is as
// sensitive as the mailbox it mirrors. Non-owners get an empty list rather than
// a 403 — the banner polls every 30s, so quiet degradation avoids both console
// noise and confirming that a mailbox is wired up at all.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    if (!(await isInboxOwner(session))) {
      return NextResponse.json({ nudges: [] })
    }

    const nudges = await prisma.nudge.findMany({
      where: { orgId: session.orgId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 50, // bounded: a mail flood must not turn this poll into a huge payload
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
