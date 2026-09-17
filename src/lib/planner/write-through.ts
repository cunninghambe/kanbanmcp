// Write-through side effects of a planner status change (spec §4.10).
//
// Two rules carry the security weight here:
//   * the planner moves a card only for the *assignee* — a reviewer or approver
//     marking their planner row done never touches someone else's board card;
//   * the Gmail label is cleared only for the mailbox owner, only with a
//     well-formed thread id, and never for a thread whose card did not move.
//
// Nothing in here may throw: a failed side effect comes back as
// `{ ok: false, error }` so the (already persisted) status change still stands.

import type { PrismaClient } from '@prisma/client'
import { logActivity } from '@/lib/agent-activity'
import { recordCardMovement } from '@/lib/card-movement'
import { inboxAgentConfig, isInboxOwner, isValidGmailId } from '@/lib/inbox-agent'
import type { SessionData } from '@/lib/session'
import type { PlannerAction, PlannerItemDTO, WriteThroughResult } from './types'

export type { WriteThroughKind, WriteThroughResult } from './types'

/** Lower-cased column names that mean "finished" (api/hud/[id]/pertinent/route.ts:9). */
export const TERMINAL_COLUMNS: ReadonlySet<string> = new Set([
  'done',
  'closed',
  'shipped',
  'archived',
])

const ACK_ACTIONS: ReadonlySet<PlannerAction> = new Set(['done', 'dismiss', 'wont_do'])
const LABEL_CLEAR_TIMEOUT_MS = 15_000

export interface DoneColumn {
  id: string
  name: string
}

/**
 * An exact `done` column (any case) wins; otherwise the first column whose name
 * is terminal, in the order given. `null` when the board has no such column.
 */
export function pickDoneColumn(
  columns: Array<{ id: string; name: string; position: number }>
): DoneColumn | null {
  const exact = columns.find((c) => c.name.trim().toLowerCase() === 'done')
  if (exact) return { id: exact.id, name: exact.name }
  const terminal = columns.find((c) => TERMINAL_COLUMNS.has(c.name.trim().toLowerCase()))
  return terminal ? { id: terminal.id, name: terminal.name } : null
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value ? value : null
}

/**
 * Fire-and-forget label clear, written against the post-PR-#38 shape: config via
 * `inboxAgentConfig()`, and the stored thread id relayed only when it looks like
 * a Gmail id (nudge rows come from the MCP agent path and are untrusted).
 */
function fireLabelClear(threadId: string): void {
  const config = inboxAgentConfig()
  if (!config) return
  if (!isValidGmailId(threadId)) return

  fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: config.token, action: 'ack', threadId }),
    signal: AbortSignal.timeout(LABEL_CLEAR_TIMEOUT_MS),
  }).catch((err) => {
    console.warn('planner nudge ack label-clear callback failed:', err)
  })
}

async function moveCardToDone(
  prisma: PrismaClient,
  args: { cardId: string; session: SessionData }
): Promise<WriteThroughResult> {
  const { cardId, session } = args

  const card = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId: session.orgId } },
    select: {
      id: true,
      boardId: true,
      columnId: true,
      board: { select: { columns: { select: { id: true, name: true, position: true } } } },
    },
  })
  if (!card) return { kind: 'none', ok: true, reason: 'card_missing' }

  const target = pickDoneColumn(card.board.columns)
  if (!target) return { kind: 'none', ok: true, reason: 'no_done_column' }

  try {
    await prisma.$transaction(async (tx) => {
      const last = await tx.card.findFirst({
        where: { columnId: target.id },
        orderBy: { position: 'desc' },
        select: { position: true },
      })
      await tx.card.update({
        where: { id: card.id },
        data: { columnId: target.id, position: last ? last.position + 1 : 0 },
      })
      await recordCardMovement(tx, {
        cardId: card.id,
        boardId: card.boardId,
        orgId: session.orgId,
        fromColumnId: card.columnId,
        toColumnId: target.id,
        movedBy: { id: session.userId, kind: 'user' },
      })
    })
  } catch (err) {
    return { kind: 'card_moved', ok: false, error: message(err) }
  }

  logActivity(session.orgId, 'planner', 'move_card', 'card', card.id, {
    toColumnId: target.id,
    via: 'planner_done',
  }).catch(() => {})

  return {
    kind: 'card_moved',
    ok: true,
    cardId: card.id,
    toColumnId: target.id,
    toColumnName: target.name,
  }
}

async function ackNudge(
  prisma: PrismaClient,
  args: { nudgeId: string; session: SessionData }
): Promise<WriteThroughResult> {
  const { nudgeId, session } = args

  // Action-time gate: items collected before an env change are still in the
  // table, so the collect-time check is not enough.
  if (!(await isInboxOwner(session))) {
    return { kind: 'nudge_acked', ok: false, error: 'not_mailbox_owner' }
  }

  try {
    const nudge = await prisma.nudge.findFirst({
      where: { id: nudgeId, orgId: session.orgId, status: 'pending' },
    })
    // Already acked (or gone): idempotent success, and nothing is re-fired.
    if (!nudge) return { kind: 'nudge_acked', ok: true, nudgeId }

    await prisma.nudge.update({
      where: { id: nudgeId },
      data: { status: 'acked', ackedById: session.userId, ackedAt: new Date() },
    })

    if (nudge.gmailThreadId) fireLabelClear(nudge.gmailThreadId)

    logActivity(session.orgId, 'planner', 'ack_nudge', 'nudge', nudgeId, {}).catch(() => {})

    return { kind: 'nudge_acked', ok: true, nudgeId }
  } catch (err) {
    return { kind: 'nudge_acked', ok: false, error: message(err) }
  }
}

/**
 * Applies the side effects of `action` on `item`. Results come back in a fixed
 * order: the card move first, then the nudge ack. Never throws.
 */
export async function applyWriteThrough(args: {
  prisma: PrismaClient
  item: PlannerItemDTO
  action: PlannerAction
  session: SessionData
}): Promise<WriteThroughResult[]> {
  const { prisma, item, action, session } = args
  const payload = item.payload
  const cardId = stringField(payload, 'cardId')
  const role = stringField(payload, 'role')
  const nudgeId = stringField(payload, 'nudgeId')

  // A card item with no role is a legacy assignee row; reviewer/approver items
  // resolve in the planner only.
  const movesCard =
    action === 'done' &&
    cardId !== null &&
    (item.source === 'email' || (item.source === 'card' && (role === null || role === 'assignee')))

  const results: WriteThroughResult[] = []

  let move: WriteThroughResult | null = null
  if (movesCard && cardId) {
    move = await moveCardToDone(prisma, { cardId, session })
    results.push(move)
  }

  if (item.source === 'email' && nudgeId && ACK_ACTIONS.has(action)) {
    if (move && move.ok === false) {
      // The Gmail label must never be cleared for a thread whose card is still
      // sitting in its old column.
      results.push({ kind: 'nudge_acked', ok: false, error: 'skipped: card move failed' })
    } else {
      results.push(await ackNudge(prisma, { nudgeId, session }))
    }
  }

  if (results.length === 0) return [{ kind: 'none', ok: true, reason: 'not_applicable' }]
  return results
}
