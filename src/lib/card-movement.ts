import type { Prisma, PrismaClient } from '@prisma/client'

export type MovementActor = { id: string; kind: 'user' | 'agent' }

export type RecordCardMovementInput = {
  cardId: string
  boardId: string
  orgId: string
  fromColumnId: string | null
  toColumnId: string
  movedBy: MovementActor
}

/**
 * Records a single column change. No-ops (returns null) when fromColumnId === toColumnId,
 * so callers can call unconditionally. Must run inside the caller's transaction so the move
 * and its audit row commit atomically.
 */
export async function recordCardMovement(
  tx: Prisma.TransactionClient,
  input: RecordCardMovementInput
): Promise<{ id: string } | null> {
  if (input.fromColumnId === input.toColumnId) return null
  const row = await tx.cardMovement.create({
    data: {
      cardId: input.cardId,
      boardId: input.boardId,
      orgId: input.orgId,
      fromColumnId: input.fromColumnId,
      toColumnId: input.toColumnId,
      movedById: input.movedBy.id,
      movedByKind: input.movedBy.kind,
    },
    select: { id: true },
  })
  return row
}

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_MOVEMENTS_CAP = 8

async function loadColumnNames(prisma: PrismaClient, boardId: string): Promise<Map<string, string>> {
  const columns = await prisma.column.findMany({
    where: { boardId },
    select: { id: true, name: true },
  })
  return new Map(columns.map((c) => [c.id, c.name]))
}

export async function formatRecentMovements(
  prisma: PrismaClient,
  args: { boardId: string; orgId: string; sinceDays?: number; limit?: number }
): Promise<string> {
  const sinceDays = args.sinceDays ?? 14
  const limit = args.limit ?? 200
  const since = new Date(Date.now() - sinceDays * DAY_MS)

  const movements = await prisma.cardMovement.findMany({
    where: { boardId: args.boardId, orgId: args.orgId, movedAt: { gte: since } },
    orderBy: { movedAt: 'desc' },
    take: limit,
    include: { card: { select: { title: true } } },
  })
  if (movements.length === 0) return ''

  const colName = await loadColumnNames(prisma, args.boardId)
  const column = (id: string | null) => (id ? (colName.get(id) ?? id) : '(new)')

  const userIds = [...new Set(movements.filter((m) => m.movedByKind === 'user').map((m) => m.movedById))]
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : []
  const userName = new Map(users.map((u) => [u.id, u.name ?? u.email]))
  const actor = (m: { movedById: string; movedByKind: string }) =>
    m.movedByKind === 'user' ? (userName.get(m.movedById) ?? m.movedById) : m.movedById

  const lines = [`Recent movements (last ${sinceDays} days):`]
  for (const m of movements) {
    const date = m.movedAt.toISOString().slice(0, 10)
    const title = m.card?.title ?? m.cardId
    lines.push(`  - "${title}": ${column(m.fromColumnId)} → ${column(m.toColumnId)} on ${date} by ${actor(m)}`)
  }

  const earliest = await prisma.cardMovement.findFirst({
    where: { boardId: args.boardId, orgId: args.orgId },
    orderBy: { movedAt: 'asc' },
    select: { movedAt: true },
  })
  if (earliest && since < earliest.movedAt) {
    lines.push(`  (movements before ${earliest.movedAt.toISOString().slice(0, 10)} are not tracked)`)
  }
  return lines.join('\n')
}

export type SessionMovement = {
  cardId: string
  cardTitle: string
  fromColumn: string | null
  toColumn: string
  movedAt: Date
}

/**
 * Structured, newest-first movement rows since a timestamp (e.g. a HUD session's
 * startedAt) — the pertinent rail's "moved this session" group. Org-scoped, capped
 * at SESSION_MOVEMENTS_CAP.
 */
export async function listMovementsSince(
  db: PrismaClient,
  args: { boardId: string; orgId: string; since: Date; limit?: number }
): Promise<SessionMovement[]> {
  const limit = Math.min(args.limit ?? SESSION_MOVEMENTS_CAP, SESSION_MOVEMENTS_CAP)

  const movements = await db.cardMovement.findMany({
    where: { boardId: args.boardId, orgId: args.orgId, movedAt: { gte: args.since } },
    orderBy: { movedAt: 'desc' },
    take: limit,
    include: { card: { select: { title: true } } },
  })
  if (movements.length === 0) return []

  const colName = await loadColumnNames(db, args.boardId)
  return movements.map((m) => ({
    cardId: m.cardId,
    cardTitle: m.card?.title ?? m.cardId,
    fromColumn: m.fromColumnId ? (colName.get(m.fromColumnId) ?? m.fromColumnId) : null,
    toColumn: colName.get(m.toColumnId) ?? m.toColumnId,
    movedAt: m.movedAt,
  }))
}
