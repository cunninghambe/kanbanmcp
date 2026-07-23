import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const EXEMPT_COLUMNS = new Set(['urgent', 'digest', 'done'])

// POST /api/cron/inbox-expire
// Rolls untouched triage cards into the Digest column. Bearer CRON_SECRET.
// Board from INBOX_BOARD_ID, look-back from INBOX_EXPIRE_DAYS (default 5).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const boardId = process.env.INBOX_BOARD_ID
  if (!boardId) {
    return NextResponse.json({ expired: 0, reason: 'unconfigured' })
  }

  const days = Number.parseInt(process.env.INBOX_EXPIRE_DAYS ?? '', 10)
  const expireDays = Number.isFinite(days) && days > 0 ? days : 5
  const cutoff = new Date(Date.now() - expireDays * 24 * 60 * 60 * 1000)

  const board = await prisma.board.findUnique({
    where: { id: boardId },
    include: { columns: { include: { cards: true } } },
  })
  if (!board) {
    return NextResponse.json({ expired: 0, reason: 'no_digest_column' })
  }

  const digestColumn = board.columns.find((c) => c.name.toLowerCase() === 'digest')
  if (!digestColumn) {
    return NextResponse.json({ expired: 0, reason: 'no_digest_column' })
  }

  // Next position at the end of the Digest column.
  let nextPosition =
    Math.max(0, ...digestColumn.cards.map((c) => c.position)) + 1

  let expired = 0
  for (const column of board.columns) {
    if (EXEMPT_COLUMNS.has(column.name.toLowerCase())) continue
    for (const card of column.cards) {
      if (card.updatedAt >= cutoff) continue
      await prisma.card.update({
        where: { id: card.id },
        data: { columnId: digestColumn.id, position: nextPosition },
      })
      await prisma.comment.create({
        data: {
          cardId: card.id,
          userId: null,
          agentId: 'inbox-agent',
          content: `Auto-expired from "${column.name}" after ${expireDays} days without touching — see the daily digest.`,
        },
      })
      nextPosition++
      expired++
    }
  }

  return NextResponse.json({ expired })
}
