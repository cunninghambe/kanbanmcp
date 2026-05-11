import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { fetchSubtree } from '@/lib/tree'

async function resolveCard(cardId: string, orgId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { board: { select: { orgId: true } } },
  })
  if (!card || card.board.orgId !== orgId) {
    throw NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }
  return card
}

function parseDepth(raw: string | null): number {
  if (!raw) return 1
  const n = parseInt(raw, 10)
  if (isNaN(n) || n < 1) return 1
  if (n > 5) return 5
  return n
}

// GET /api/cards/[cardId]/children?depth=N
export async function GET(
  req: NextRequest,
  { params }: { params: { cardId: string } }
) {
  try {
    const session = await requireSession(req)
    await resolveCard(params.cardId, session.orgId)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const depth = parseDepth(req.nextUrl.searchParams.get('depth'))
    const nodes = await fetchSubtree(prisma, params.cardId, depth)

    if (nodes.length === 0) {
      return apiError(404, 'Card not found')
    }

    const [root, ...descendants] = nodes
    return NextResponse.json({ root, descendants })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/cards/[cardId]/children error:', err)
    return apiError(500, 'Internal server error')
  }
}
