import type { Prisma } from '@prisma/client'

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
