import { prisma } from '@/lib/db'
import { logActivity } from '@/lib/agent-activity'
import { formatRecentMovements } from '@/lib/card-movement'
import { createPendingChangeSet, changeItemInputSchema } from '@/lib/changesets'
import { buildDispatchPrompt, parseDispatchAnswer, isDispatchTarget } from './dispatch'
import type { DispatchTarget } from './dispatch'
import { MAX_CARDS_PER_COLUMN, maxBoardContextChars } from './config'
import * as defaultMcp from './mcp-client'
import type { DispatchMcpClient } from './mcp-client'

// ─── ClaudeMCP seam (overridable in tests) ───────────────────────────────────

let mcpOverride: DispatchMcpClient | null = null

export function __setMcpClientForTests(client: DispatchMcpClient | null): void {
  mcpOverride = client
}

function mcp(): DispatchMcpClient {
  return mcpOverride ?? defaultMcp
}

// ─── Tuning ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000

function maxDispatchMs(): number {
  const raw = process.env.HUD_DISPATCH_MAX_MS
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60_000
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Dispatches run as independent async tasks so several can be in flight at once
// (the HUD chair fires multiple questions in parallel). Tracked for test draining.
const inFlight = new Map<string, Promise<void>>()

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

// ─── Board context (read-only snapshot for the board target) ─────────────────

type BoardCard = { id: string; title: string; priority: string; dueDate: Date | null }
type BoardSnapshot = {
  name: string
  id: string
  columns: Array<{ name: string; id: string; cards: BoardCard[] }>
}

/**
 * Serializes a board snapshot into the read-only prompt context, bounding both
 * the number of cards per column and the total length so an enormous board can
 * never inflate the external prompt (and its token cost) without limit. Pure.
 */
export function renderBoardContext(
  board: BoardSnapshot,
  movements: string | undefined,
  opts: { maxCardsPerColumn: number; maxChars: number }
): string {
  const lines: string[] = [`Board "${board.name}" (id ${board.id}):`]
  for (const col of board.columns) {
    lines.push(`Column "${col.name}" (id ${col.id}):`)
    if (col.cards.length === 0) lines.push('  (no cards)')
    const shown = col.cards.slice(0, opts.maxCardsPerColumn)
    for (const c of shown) {
      const due = c.dueDate ? ` due ${c.dueDate.toISOString().slice(0, 10)}` : ''
      lines.push(`  - [${c.id}] ${c.title} (priority ${c.priority}${due})`)
    }
    if (col.cards.length > opts.maxCardsPerColumn) {
      lines.push(`  … (${col.cards.length - shown.length} more cards omitted)`)
    }
  }
  const body = lines.join('\n')
  const full = movements ? `${body}\n\n${movements}` : body
  return truncateContext(full, opts.maxChars)
}

function truncateContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = '\n… [board context truncated]'
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker
}

async function buildBoardContext(boardId: string, orgId: string): Promise<string | undefined> {
  const board = await prisma.board.findFirst({
    where: { id: boardId, orgId },
    include: {
      columns: {
        orderBy: { position: 'asc' },
        include: {
          cards: {
            orderBy: { position: 'asc' },
            // Fetch at most one past the cap so we can flag "more omitted"
            // without pulling an unbounded number of rows into memory.
            take: MAX_CARDS_PER_COLUMN + 1,
            select: { id: true, title: true, priority: true, dueDate: true },
          },
        },
      },
    },
  })
  if (!board) return undefined

  const movements = await formatRecentMovements(prisma, { boardId: board.id, orgId })
  return renderBoardContext(board, movements, {
    maxCardsPerColumn: MAX_CARDS_PER_COLUMN,
    maxChars: maxBoardContextChars(),
  })
}

// ─── Suggestion → pending ChangeSet ──────────────────────────────────────────

async function maybeCreateChangeSet(
  dispatch: { id: string; orgId: string; hudSessionId: string },
  suggestion: NonNullable<ReturnType<typeof parseDispatchAnswer>['suggestion']>
): Promise<string | null> {
  // Validate each suggested item against the op schema; drop anything invalid
  // rather than failing the whole answer.
  const validItems = suggestion.items
    .map((it) => changeItemInputSchema.safeParse(it))
    .filter((r) => r.success)
    .map((r) => (r as { success: true; data: ReturnType<typeof changeItemInputSchema.parse> }).data)

  if (validItems.length === 0) return null

  // Confirm the suggested board, if any, belongs to the org (prevent cross-org IDOR).
  let boardId = suggestion.boardId
  if (boardId) {
    const board = await prisma.board.findFirst({
      where: { id: boardId, orgId: dispatch.orgId },
      select: { id: true },
    })
    if (!board) boardId = undefined
  }

  const changeSet = await createPendingChangeSet(prisma, {
    orgId: dispatch.orgId,
    createdById: 'Host Meeting HUD',
    boardId,
    summary: suggestion.summary,
    hudSessionId: dispatch.hudSessionId,
    dispatchId: dispatch.id,
    items: validItems,
  })

  logActivity(dispatch.orgId, 'Host Meeting HUD', 'propose_changeset', 'change_set', changeSet.id, {
    dispatchId: dispatch.id,
    itemCount: changeSet.items.length,
  }).catch(() => {})

  return changeSet.id
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function processDispatch(dispatchId: string): Promise<void> {
  const dispatch = await prisma.agentDispatch.findUnique({ where: { id: dispatchId } })
  if (!dispatch) return
  if (TERMINAL.has(dispatch.status)) return
  if (!isDispatchTarget(dispatch.target)) {
    await prisma.agentDispatch.update({
      where: { id: dispatchId },
      data: { status: 'failed', error: `Unknown target "${dispatch.target}"`, finishedAt: new Date() },
    })
    return
  }
  const target: DispatchTarget = dispatch.target

  await prisma.agentDispatch.update({
    where: { id: dispatchId },
    data: { status: 'running', startedAt: new Date() },
  })
  logActivity(dispatch.orgId, 'Host Meeting HUD', 'dispatch_agent', 'agent_dispatch', dispatch.id, {
    target,
  }).catch(() => {})

  // Build the prompt (board target gets a read-only board snapshot).
  let context: string | undefined
  if (target === 'board') {
    const board = await prisma.hudSession.findUnique({
      where: { id: dispatch.hudSessionId },
      select: { boardId: true },
    })
    if (board?.boardId) context = await buildBoardContext(board.boardId, dispatch.orgId)
  }
  const prompt = buildDispatchPrompt({ target, question: dispatch.question, context })

  // Submit to ClaudeMCP.
  let jobId: string
  try {
    const submitted = await mcp().submitDispatch({ prompt, timeoutMs: maxDispatchMs() })
    jobId = submitted.jobId
    await prisma.agentDispatch.update({ where: { id: dispatchId }, data: { jobId } })
  } catch (err) {
    await failDispatch(dispatchId, err)
    return
  }

  // Poll until terminal, deadline, or chair cancellation.
  const deadline = Date.now() + maxDispatchMs() + 30_000
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)

    const current = await prisma.agentDispatch.findUnique({
      where: { id: dispatchId },
      select: { status: true },
    })
    if (!current || current.status === 'cancelled') {
      // The chair (or an ending session) cancelled this dispatch. Propagate to
      // ClaudeMCP so the external job stops burning tokens, then bow out.
      if (current?.status === 'cancelled') await cancelExternalJob(jobId)
      return
    }

    let status: Awaited<ReturnType<DispatchMcpClient['pollDispatchStatus']>>
    try {
      status = await mcp().pollDispatchStatus(jobId)
    } catch (err) {
      // Transient — keep polling until the deadline.
      console.warn('[host-hud] transient poll error', err instanceof Error ? err.message : err)
      continue
    }

    if (status.state === 'done') {
      await finishDispatch(dispatch, status.output ?? '')
      return
    }
    if (['failed', 'interrupted', 'cancelled'].includes(status.state)) {
      await failDispatch(dispatchId, status.errorDetail ?? `state=${status.state}`)
      return
    }
    // running / queued / unknown → keep polling
  }
  await failDispatch(dispatchId, `Dispatch timed out after ${maxDispatchMs()}ms`)
}

async function finishDispatch(
  dispatch: { id: string; orgId: string; hudSessionId: string },
  output: string
): Promise<void> {
  const parsed = parseDispatchAnswer(output)

  let proposedChangeSetId: string | null = null
  if (parsed.suggestion) {
    try {
      proposedChangeSetId = await maybeCreateChangeSet(dispatch, parsed.suggestion)
    } catch (err) {
      console.error('[host-hud] failed to create changeset from suggestion', err)
    }
  }

  await prisma.agentDispatch.update({
    where: { id: dispatch.id },
    data: {
      status: 'done',
      answer: parsed.answer,
      citations: JSON.stringify(parsed.citations),
      confidence: parsed.confidence,
      proposedChangeSetId,
      finishedAt: new Date(),
    },
  })
}

/** Best-effort cancellation of the external ClaudeMCP job; never throws. */
async function cancelExternalJob(jobId: string): Promise<void> {
  try {
    await mcp().cancelDispatch(jobId)
  } catch (err) {
    console.warn('[host-hud] cancel propagation failed', err instanceof Error ? err.message : err)
  }
}

async function failDispatch(dispatchId: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err)
  await prisma.agentDispatch.update({
    where: { id: dispatchId },
    data: { status: 'failed', error: msg.slice(0, 2000), finishedAt: new Date() },
  })
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Enqueues a dispatch for processing (idempotent per id while in flight). */
export function enqueueDispatch(dispatchId: string): void {
  if (inFlight.has(dispatchId)) return
  const p = processDispatch(dispatchId)
    .catch((err) => console.error('[host-hud] unhandled dispatch error', dispatchId, err))
    .finally(() => inFlight.delete(dispatchId))
  inFlight.set(dispatchId, p)
}

/** For tests: resolves when all in-flight dispatches have settled. */
export async function flushForTests(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight.values()])
  }
}

/** Called at app boot: re-enqueue any non-terminal dispatches interrupted by a restart. */
export async function bootstrapWorker(): Promise<void> {
  // Ops/demo escape hatch: skip re-enqueue (e.g. when inspecting captured state).
  if (process.env.HUD_DISABLE_DISPATCH_BOOTSTRAP === '1') return

  const pending = await prisma.agentDispatch.findMany({
    where: { status: { in: ['queued', 'running'] } },
    select: { id: true },
  })
  for (const d of pending) enqueueDispatch(d.id)
}
