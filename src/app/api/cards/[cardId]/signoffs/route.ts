import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const VALID_ROLES = ['REVIEWER', 'APPROVER'] as const
const VALID_DECISIONS = ['APPROVED', 'REJECTED', 'REQUESTED_CHANGES'] as const

const createSignoffSchema = z.object({
  role: z.enum(VALID_ROLES),
  decision: z.enum(VALID_DECISIONS),
  comment: z.string().max(2000).optional(),
})

// duplicated from cards/[cardId]/route.ts to avoid premature abstraction
async function resolveCard(cardId: string, orgId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { board: { select: { orgId: true } } },
  })
  if (!card) {
    throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }
  if (card.board.orgId !== orgId) {
    throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }
  return card
}

// POST /api/cards/[cardId]/signoffs
// Records a reviewer or approver signoff decision on a card.
// Only the card's assigned reviewer may submit role=REVIEWER;
// only the assigned approver may submit role=APPROVER.
// API-key sessions (userId='') always receive 403 — signoffs are human decisions.
export async function POST(req: NextRequest, ctx: { params: Promise<{ cardId: string }> }) {
  const params = await ctx.params
  try {
    const session = await requireSession(req)
    const card = await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const result = createSignoffSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { role, decision, comment } = result.data

    if (role === 'REVIEWER') {
      if (card.reviewerId === null) {
        return apiError(400, 'No reviewer assigned')
      }
      if (card.reviewerId !== session.userId) {
        return apiError(403, 'Only the assigned reviewer may sign off as REVIEWER')
      }
    } else {
      if (card.approverId === null) {
        return apiError(400, 'No approver assigned')
      }
      if (card.approverId !== session.userId) {
        return apiError(403, 'Only the assigned approver may sign off as APPROVER')
      }
    }

    const signoff = await prisma.signoff.create({
      data: {
        cardId: params.cardId,
        userId: session.userId,
        role,
        decision,
        comment: comment ?? null,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    })

    return NextResponse.json({ signoff }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/cards/[cardId]/signoffs error:', err)
    return apiError(500, 'Internal server error')
  }
}

// GET /api/cards/[cardId]/signoffs
// Returns all signoffs for the card, ordered by createdAt desc (newest first).
// With ?latestPerRole=true, returns { signoffs, latest: { reviewer, approver } }
// where each latest entry is the most recent signoff for that role.
export async function GET(req: NextRequest, ctx: { params: Promise<{ cardId: string }> }) {
  const params = await ctx.params
  try {
    const session = await requireSession(req)
    await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const latestPerRole = new URL(req.url).searchParams.get('latestPerRole') === 'true'

    const userSelect = { select: { id: true, name: true, email: true } }

    const signoffs = await prisma.signoff.findMany({
      where: { cardId: params.cardId },
      orderBy: { createdAt: 'desc' },
      include: { user: userSelect },
    })

    if (!latestPerRole) {
      return NextResponse.json({ signoffs })
    }

    const [reviewer, approver] = await Promise.all([
      prisma.signoff.findFirst({
        where: { cardId: params.cardId, role: 'REVIEWER' },
        orderBy: { createdAt: 'desc' },
        include: { user: userSelect },
      }),
      prisma.signoff.findFirst({
        where: { cardId: params.cardId, role: 'APPROVER' },
        orderBy: { createdAt: 'desc' },
        include: { user: userSelect },
      }),
    ])

    return NextResponse.json({ signoffs, latest: { reviewer, approver } })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/cards/[cardId]/signoffs error:', err)
    return apiError(500, 'Internal server error')
  }
}
