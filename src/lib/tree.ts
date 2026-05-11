import type { Prisma, PrismaClient } from '@prisma/client'
import { MAX_NESTING_DEPTH } from './cards'

export { computeChildPathAndDepth, MAX_NESTING_DEPTH } from './cards'

type Tx = Prisma.TransactionClient

export interface SignoffSummary {
  id: string
  decision: string
  createdAt: Date
  user: { id: string; name: string; email: string }
}

export interface SubtreeNode {
  id: string
  title: string
  description: string | null
  parentCardId: string | null
  path: string
  depth: number
  aiAutoReview: boolean
  assigneeId: string | null
  reviewerId: string | null
  approverId: string | null
  assignee: { id: string; email: string; name: string } | null
  reviewer: { id: string; email: string; name: string } | null
  approver: { id: string; email: string; name: string } | null
  aiReviewParams: { model: string; rubric: string; customInstructions?: string } | null
  signoffs: {
    reviewer: SignoffSummary | null
    approver: SignoffSummary | null
  }
}

export async function recomputeSubtreePathAndDepth(
  tx: Tx,
  cardId: string,
  newParentId: string | null
): Promise<{ updatedCount: number }> {
  const card = await tx.card.findUnique({
    where: { id: cardId },
    select: { path: true, depth: true },
  })
  if (!card) return { updatedCount: 0 }

  const oldSubtreePrefix = card.path === '' ? `/${cardId}/` : `${card.path}${cardId}/`

  let newCardPath: string
  let newDepth: number

  if (newParentId === null) {
    newCardPath = ''
    newDepth = 0
  } else {
    const parent = await tx.card.findUnique({
      where: { id: newParentId },
      select: { path: true, depth: true },
    })
    if (!parent) return { updatedCount: 0 }
    const prefix = parent.path === '' ? '/' : parent.path
    newCardPath = `${prefix}${newParentId}/`
    newDepth = parent.depth + 1
  }

  const depthDelta = newDepth - card.depth
  const newSubtreePrefix = newCardPath === '' ? `/${cardId}/` : `${newCardPath}${cardId}/`

  await tx.card.update({
    where: { id: cardId },
    data: { path: newCardPath, depth: newDepth },
  })

  const likePattern = `${oldSubtreePrefix}%`
  await tx.$executeRaw`
    UPDATE "cards"
    SET path = REPLACE(path, ${oldSubtreePrefix}, ${newSubtreePrefix}),
        depth = depth + ${depthDelta}
    WHERE path LIKE ${likePattern}
  `

  return { updatedCount: 1 }
}

export async function wouldFormCycle(
  tx: Tx,
  cardId: string,
  candidateAncestorId: string
): Promise<boolean> {
  let cursor: string | null = candidateAncestorId
  for (let i = 0; i <= MAX_NESTING_DEPTH; i++) {
    if (cursor === null) return false
    if (cursor === cardId) return true
    const row: { parentCardId: string | null } | null = await tx.card.findUnique({
      where: { id: cursor },
      select: { parentCardId: true },
    })
    if (!row) return false
    cursor = row.parentCardId
  }
  return true
}

export async function fetchSubtree(
  prisma: PrismaClient,
  rootId: string,
  maxDepth: number
): Promise<SubtreeNode[]> {
  const root = await prisma.card.findUnique({
    where: { id: rootId },
    select: {
      id: true,
      title: true,
      description: true,
      parentCardId: true,
      path: true,
      depth: true,
      aiAutoReview: true,
      aiReviewParams: true,
      assigneeId: true,
      reviewerId: true,
      approverId: true,
      assignee: { select: { id: true, email: true, name: true } },
      reviewer: { select: { id: true, email: true, name: true } },
      approver: { select: { id: true, email: true, name: true } },
    },
  })
  if (!root) return []

  const subtreePrefix = root.path === '' ? `/${rootId}/` : `${root.path}${rootId}/`
  const maxAbsoluteDepth = root.depth + maxDepth

  const descendants = await prisma.card.findMany({
    where: {
      path: { startsWith: subtreePrefix },
      depth: { lte: maxAbsoluteDepth },
    },
    orderBy: [{ path: 'asc' }, { position: 'asc' }],
    select: {
      id: true,
      title: true,
      description: true,
      parentCardId: true,
      path: true,
      depth: true,
      aiAutoReview: true,
      aiReviewParams: true,
      assigneeId: true,
      reviewerId: true,
      approverId: true,
      assignee: { select: { id: true, email: true, name: true } },
      reviewer: { select: { id: true, email: true, name: true } },
      approver: { select: { id: true, email: true, name: true } },
    },
  })

  const allCards = [root, ...descendants]
  const allIds = allCards.map((c) => c.id)

  const allSignoffs = await prisma.signoff.findMany({
    where: { cardId: { in: allIds } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      cardId: true,
      role: true,
      decision: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  })

  type SignoffRow = (typeof allSignoffs)[number]
  const latestByCardRole = new Map<string, SignoffRow>()
  for (const s of allSignoffs) {
    const key = `${s.cardId}:${s.role}`
    if (!latestByCardRole.has(key)) latestByCardRole.set(key, s)
  }

  function toSignoffSummary(s: SignoffRow): SignoffSummary {
    return { id: s.id, decision: s.decision, createdAt: s.createdAt, user: s.user }
  }

  function toNode(c: (typeof allCards)[number]): SubtreeNode {
    const reviewerKey = `${c.id}:REVIEWER`
    const approverKey = `${c.id}:APPROVER`
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      parentCardId: c.parentCardId,
      path: c.path,
      depth: c.depth,
      aiAutoReview: c.aiAutoReview,
      assigneeId: c.assigneeId,
      reviewerId: c.reviewerId,
      approverId: c.approverId,
      assignee: c.assignee,
      reviewer: c.reviewer,
      approver: c.approver,
      aiReviewParams: parseAiReviewParams(c.aiReviewParams),
      signoffs: {
        reviewer: latestByCardRole.has(reviewerKey)
          ? toSignoffSummary(latestByCardRole.get(reviewerKey)!)
          : null,
        approver: latestByCardRole.has(approverKey)
          ? toSignoffSummary(latestByCardRole.get(approverKey)!)
          : null,
      },
    }
  }

  return allCards.map(toNode)
}

function parseAiReviewParams(
  raw: string | null
): { model: string; rubric: string; customInstructions?: string } | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as { model: string; rubric: string; customInstructions?: string }
  } catch {
    return null
  }
}
