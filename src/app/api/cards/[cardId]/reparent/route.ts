import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { recomputeSubtreePathAndDepth, wouldFormCycle } from '@/lib/tree'
import { MAX_NESTING_DEPTH, decodeAiReviewParams } from '@/lib/cards'
import { resolveCard } from '@/lib/resolve-card'

const reparentSchema = z.object({
  parentCardId: z.string().nullable(),
})

// POST /api/cards/[cardId]/reparent
// Body: { parentCardId: string | null }
export async function POST(req: NextRequest, ctx: { params: Promise<{ cardId: string }> }) {
  const params = await ctx.params
  try {
    const session = await requireSession(req)
    const existingCard = await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json()
    const parsed = reparentSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 }
      )
    }

    const { parentCardId: newParentId } = parsed.data

    if (newParentId === existingCard.id) {
      return apiError(400, 'Cannot reparent a card to itself')
    }

    await prisma.$transaction(async (tx) => {
      if (newParentId !== null) {
        const newParent = await tx.card.findUnique({
          where: { id: newParentId },
          select: { boardId: true, depth: true, path: true },
        })
        if (!newParent || newParent.boardId !== existingCard.boardId) {
          throw NextResponse.json(
            { error: 'New parent must be on the same board' },
            { status: 400 }
          )
        }

        const cycle = await wouldFormCycle(tx, params.cardId, newParentId)
        if (cycle) {
          throw NextResponse.json({ error: 'Cycle detected' }, { status: 400 })
        }

        const subtreePrefix =
          existingCard.path === '' ? `/${params.cardId}/` : `${existingCard.path}${params.cardId}/`
        const maxDepthResult = await tx.$queryRaw<Array<{ maxDepth: number | null }>>`
          SELECT MAX(depth) as maxDepth FROM "cards" WHERE path LIKE ${subtreePrefix + '%'}
        `
        const maxDescendantDepth = maxDepthResult[0]?.maxDepth ?? null
        const subtreeMaxDepth =
          maxDescendantDepth !== null ? maxDescendantDepth - existingCard.depth : 0

        if (newParent.depth + 1 + subtreeMaxDepth >= MAX_NESTING_DEPTH) {
          throw NextResponse.json(
            { error: `Maximum nesting depth (${MAX_NESTING_DEPTH}) reached` },
            { status: 400 }
          )
        }
      }

      await tx.card.update({
        where: { id: params.cardId },
        data: { parentCardId: newParentId },
      })
      await recomputeSubtreePathAndDepth(tx, params.cardId, newParentId)
    })

    const card = await prisma.card.findUnique({ where: { id: params.cardId } })
    return NextResponse.json({
      card: { ...card, aiReviewParams: decodeAiReviewParams(card?.aiReviewParams ?? null) },
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/cards/[cardId]/reparent error:', err)
    return apiError(500, 'Internal server error')
  }
}
