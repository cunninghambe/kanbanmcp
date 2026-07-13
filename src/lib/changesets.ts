import { z } from 'zod'
import type { PrismaClient, Prisma } from '@prisma/client'
import { recordCardMovement } from '@/lib/card-movement'

/**
 * ChangeSet op schemas — the validated payload shapes for proposed (never
 * auto-applied) board mutations. A minimal realization of MEETINGCOPILOTSPEC
 * §3.2 / §6.2: board-card ops only, since the Meeting/Commitment models do not
 * exist yet. Commitment ops will be added when that pipeline lands.
 */

const priorityEnum = z.enum(['none', 'low', 'medium', 'high', 'critical'])

export const opPayloadSchemas = {
  create_card: z.object({
    boardId: z.string().min(1),
    columnId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    priority: priorityEnum.optional(),
    dueDate: z.string().datetime().optional(),
  }),
  move_card: z.object({
    cardId: z.string().min(1),
    columnId: z.string().min(1),
    position: z.number().int().positive(),
  }),
  update_card: z.object({
    cardId: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    priority: priorityEnum.optional(),
    dueDate: z.string().datetime().nullable().optional(),
  }),
  comment_card: z.object({
    cardId: z.string().min(1),
    content: z.string().min(1),
  }),
} as const

export type ChangeOp = keyof typeof opPayloadSchemas
export const CHANGE_OPS = Object.keys(opPayloadSchemas) as ChangeOp[]

export const evidenceSchema = z.object({
  quote: z.string().min(1),
  artifactId: z.string().optional(),
  startMs: z.number().optional(),
  endMs: z.number().optional(),
  speakerLabel: z.string().optional(),
})

export const changeItemInputSchema = z
  .object({
    op: z.enum(CHANGE_OPS as [ChangeOp, ...ChangeOp[]]),
    payload: z.record(z.unknown()),
    targetCardId: z.string().optional(),
    evidence: evidenceSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .superRefine((item, ctx) => {
    const schema = opPayloadSchemas[item.op]
    const parsed = schema.safeParse(item.payload)
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid payload for op "${item.op}": ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        path: ['payload'],
      })
    }
  })

export const proposeChangeSetInputSchema = z.object({
  boardId: z.string().min(1).optional(),
  summary: z.string().optional(),
  items: z.array(changeItemInputSchema).min(1, 'At least one change item is required'),
})

export type ProposeChangeSetInput = z.infer<typeof proposeChangeSetInputSchema>

export interface CreatePendingChangeSetArgs extends ProposeChangeSetInput {
  orgId: string
  createdById: string
  hudSessionId?: string
  dispatchId?: string
}

/**
 * Creates a PENDING ChangeSet + its items. This NEVER mutates the board — it
 * only records a proposal awaiting human approval (see the decisions/apply
 * endpoints, which require an iron-session and reject API-key auth).
 */
export async function createPendingChangeSet(
  prisma: PrismaClient,
  args: CreatePendingChangeSetArgs
) {
  return prisma.changeSet.create({
    data: {
      orgId: args.orgId,
      boardId: args.boardId ?? null,
      hudSessionId: args.hudSessionId ?? null,
      dispatchId: args.dispatchId ?? null,
      status: 'pending',
      createdById: args.createdById,
      summary: args.summary ?? null,
      items: {
        create: args.items.map((item) => ({
          op: item.op,
          payload: JSON.stringify(item.payload),
          targetCardId: item.targetCardId ?? null,
          evidence: item.evidence ? JSON.stringify(item.evidence) : null,
          confidence: item.confidence ?? null,
          decision: 'pending',
        })),
      },
    },
    include: { items: true },
  })
}

// ─── Apply (human-approved, transactional) ───────────────────────────────────

export interface ApplyChangeSetArgs {
  orgId: string
  /** The human applying — used as createdById/userId for created cards/comments. */
  userId: string
  /** Subset of item ids to apply; if omitted, every pending item is applied. */
  approvedItemIds?: string[]
}

/** Applies a single change item inside a transaction. Throws on any failure. */
async function applyItem(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string,
  op: string,
  payload: Record<string, unknown>
): Promise<{ resourceType: string; resourceId: string }> {
  switch (op) {
    case 'create_card': {
      const p = opPayloadSchemas.create_card.parse(payload)
      const board = await tx.board.findFirst({ where: { id: p.boardId, orgId }, select: { id: true } })
      if (!board) throw new Error('Board not found or access denied')
      const column = await tx.column.findFirst({ where: { id: p.columnId, boardId: p.boardId } })
      if (!column) throw new Error('Column not found on board')
      const agg = await tx.card.aggregate({ where: { columnId: p.columnId }, _max: { position: true } })
      const card = await tx.card.create({
        data: {
          title: p.title,
          description: p.description,
          columnId: p.columnId,
          boardId: p.boardId,
          priority: p.priority ?? 'none',
          position: (agg._max.position ?? 0) + 1,
          createdById: userId,
          dueDate: p.dueDate ? new Date(p.dueDate) : undefined,
        },
      })
      return { resourceType: 'card', resourceId: card.id }
    }
    case 'move_card': {
      const p = opPayloadSchemas.move_card.parse(payload)
      const existing = await tx.card.findFirst({ where: { id: p.cardId, board: { orgId } } })
      if (!existing) throw new Error('Card not found or access denied')
      const column = await tx.column.findFirst({ where: { id: p.columnId, boardId: existing.boardId } })
      if (!column) throw new Error('Target column not found on board')
      await tx.card.update({ where: { id: p.cardId }, data: { columnId: p.columnId, position: p.position } })
      await recordCardMovement(tx, {
        cardId: p.cardId,
        boardId: existing.boardId,
        orgId,
        fromColumnId: existing.columnId,
        toColumnId: p.columnId,
        movedBy: { id: userId, kind: 'user' },
      })
      return { resourceType: 'card', resourceId: p.cardId }
    }
    case 'update_card': {
      const p = opPayloadSchemas.update_card.parse(payload)
      const existing = await tx.card.findFirst({ where: { id: p.cardId, board: { orgId } } })
      if (!existing) throw new Error('Card not found or access denied')
      const data: Record<string, unknown> = {}
      if (p.title !== undefined) data.title = p.title
      if (p.description !== undefined) data.description = p.description
      if (p.priority !== undefined) data.priority = p.priority
      if (p.dueDate !== undefined) data.dueDate = p.dueDate ? new Date(p.dueDate) : null
      await tx.card.update({ where: { id: p.cardId }, data })
      return { resourceType: 'card', resourceId: p.cardId }
    }
    case 'comment_card': {
      const p = opPayloadSchemas.comment_card.parse(payload)
      const existing = await tx.card.findFirst({ where: { id: p.cardId, board: { orgId } } })
      if (!existing) throw new Error('Card not found or access denied')
      const comment = await tx.comment.create({
        data: { cardId: p.cardId, userId, content: p.content },
      })
      return { resourceType: 'comment', resourceId: comment.id }
    }
    default:
      throw new Error(`Unsupported op "${op}"`)
  }
}

/**
 * Applies approved items of a pending ChangeSet in a single transaction. Each
 * item's success/failure is recorded; the ChangeSet ends `applied` (all done) or
 * `partially_applied` (some failed). Returns the per-item outcomes so the caller
 * can write AgentActivity provenance.
 */
export async function applyChangeSet(prisma: PrismaClient, changeSetId: string, args: ApplyChangeSetArgs) {
  const changeSet = await prisma.changeSet.findFirst({
    where: { id: changeSetId, orgId: args.orgId },
    include: { items: true },
  })
  if (!changeSet) return { ok: false as const, reason: 'not_found' as const }
  if (changeSet.status === 'applied') return { ok: false as const, reason: 'already_applied' as const }

  const approve = args.approvedItemIds ? new Set(args.approvedItemIds) : null
  const toApply = changeSet.items.filter(
    (it) => it.decision !== 'rejected' && (approve ? approve.has(it.id) : true)
  )

  const applied: Array<{ itemId: string; resourceType: string; resourceId: string; op: string }> = []
  let failures = 0

  for (const item of toApply) {
    try {
      const payload = JSON.parse(item.payload) as Record<string, unknown>
      const result = await prisma.$transaction((tx) =>
        applyItem(tx, args.orgId, args.userId, item.op, payload)
      )
      await prisma.changeItem.update({
        where: { id: item.id },
        data: { decision: 'approved', appliedAt: new Date(), error: null },
      })
      applied.push({ itemId: item.id, op: item.op, ...result })
    } catch (err) {
      failures++
      await prisma.changeItem.update({
        where: { id: item.id },
        data: { error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) },
      })
    }
  }

  const remainingPending = await prisma.changeItem.count({
    where: { changeSetId, decision: 'pending' },
  })
  const status = failures > 0 || remainingPending > 0 ? 'partially_applied' : 'applied'

  await prisma.changeSet.update({
    where: { id: changeSetId },
    data: { status, approvedById: args.userId, appliedAt: new Date() },
  })

  return { ok: true as const, status, applied, failures }
}

// ─── Lazy expiry ──────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * TTL for `pending` ChangeSets, from the `CHANGESET_TTL_DAYS` env var.
 * Unset/empty/non-numeric falls back to the default; a numeric value below
 * the 1-day minimum is clamped up to it.
 */
export function changeSetTtlDays(): number {
  const raw = process.env.CHANGESET_TTL_DAYS
  if (!raw) return 14
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 14
  return Math.max(1, parsed)
}

/**
 * Marks the org's stale `pending` ChangeSets `expired`. Only `pending` sets
 * are eligible — `partially_applied` never expires, since a human has already
 * started deciding on it. Returns the number of sets updated.
 */
export async function expireStaleChangeSets(db: PrismaClient, orgId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - changeSetTtlDays() * DAY_MS)
  const result = await db.changeSet.updateMany({
    where: { orgId, status: 'pending', createdAt: { lt: cutoff } },
    data: { status: 'expired' },
  })
  return result.count
}
