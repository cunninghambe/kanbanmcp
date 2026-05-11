import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'

type CardWithBoard = Prisma.CardGetPayload<{
  include: { board: { select: { orgId: true; id: true } } }
}>

/**
 * Fetches a card by ID, verifying org ownership. Throws a 404 NextResponse
 * if the card does not exist or belongs to a different org.
 */
export async function resolveCard(cardId: string, orgId: string): Promise<CardWithBoard> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { board: { select: { orgId: true, id: true } } },
  })
  if (!card || card.board.orgId !== orgId) {
    throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }
  return card
}
