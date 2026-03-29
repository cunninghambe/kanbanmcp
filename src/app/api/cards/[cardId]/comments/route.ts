import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const createCommentSchema = z.object({
  content: z.string().min(1, 'Comment content is required'),
})

/**
 * Verifies the card exists and its board belongs to the session user's org.
 */
async function resolveCard(cardId: string, orgId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { board: { select: { orgId: true } } },
  })
  if (!card) {
    throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }
  if (card.board.orgId !== orgId) {
    throw NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return card
}

// GET /api/cards/[cardId]/comments
// Returns all comments for the card, ordered by creation time ascending.
export async function GET(
  req: NextRequest,
  { params }: { params: { cardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const comments = await prisma.comment.findMany({
      where: { cardId: params.cardId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    })

    return NextResponse.json({ comments })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/cards/[cardId]/comments error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/cards/[cardId]/comments
// Creates a comment on the card, linked to the session user.
export async function POST(
  req: NextRequest,
  { params }: { params: { cardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = createCommentSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const comment = await prisma.comment.create({
      data: {
        cardId: params.cardId,
        userId: session.userId,
        content: result.data.content,
      },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    })

    return NextResponse.json({ comment }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/cards/[cardId]/comments error:', err)
    return apiError(500, 'Internal server error')
  }
}
