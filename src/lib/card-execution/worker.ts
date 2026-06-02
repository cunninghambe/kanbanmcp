import { slugifyBoardName } from './projects'
import { buildEnrichedSpec, parseDeliverableOutput, resolveProjectPath, attachDeliverableArtifact, assertSafeDeliverablePath } from './deliverables'
import { postDeliverySummaryComment, postProtocolWarningComment, postExecutionComment } from './comments'
import { withKeyedLock } from '@/lib/keyed-mutex'
import type { submitClaudeBuild, pollClaudeJobStatus, listClaudeProjects } from './mcp-client'

// ─── Types ────────────────────────────────────────────────────────────────────

type McpClient = {
  submitClaudeBuild: typeof submitClaudeBuild
  pollClaudeJobStatus: typeof pollClaudeJobStatus
  listClaudeProjects: typeof listClaudeProjects
}

type PollResult = Awaited<ReturnType<typeof pollClaudeJobStatus>>
type BoardColumn = { id: string; name: string }

// ─── Lazy db accessor (avoids TDZ in tests that declare mockPrisma before vi.mock) ──
// Memoize the import PROMISE so concurrent callers share a single dynamic import
// instead of each firing their own (which both avoids redundant imports and
// prevents a concurrent-dynamic-import race against the test module mock).
let prismaPromise: Promise<(typeof import('@/lib/db'))['prisma']> | null = null

async function db() {
  if (!prismaPromise) {
    prismaPromise = import('@/lib/db').then((mod) => mod.prisma)
  }
  return prismaPromise
}

// ─── MCP client seam ─────────────────────────────────────────────────────────

let mcpClientOverride: McpClient | null = null

export function __setMcpClientForTests(client: McpClient | null): void {
  mcpClientOverride = client
}

async function getMcpClient(): Promise<McpClient> {
  if (mcpClientOverride) return mcpClientOverride
  return import('./mcp-client')
}

// ─── Promise-chain queue ──────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000
const DEBOUNCE_MS = 60_000

// Hard ceiling on how long a single execution may be polled before it is
// force-failed. Configurable via env for ops tuning; defaults to 30 minutes.
function maxExecutionMs(): number {
  const raw = process.env.CARD_EXEC_MAX_MS
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60_000
}

// After this many consecutive transient poll errors we give up and fail the
// execution rather than rescheduling forever.
const MAX_POLL_RETRIES = 5
// Backoff applied to a retry tick after a transient poll error.
const POLL_RETRY_BACKOFF_MS = 5_000
// After this many consecutive unrecognised states we classify the job as failed.
const MAX_UNKNOWN_STATES = 5

type PollEntry = {
  cardId: string
  // Wall-clock deadline; once exceeded the execution is force-failed.
  deadlineAt: number
  // Consecutive transient poll-call errors (reset on a successful poll).
  retries: number
  // Consecutive unrecognised (non-running, non-terminal) states.
  unknowns: number
}

// Active poll entries keyed by jobId — internal, not exported.
const activePollJobs = new Map<string, PollEntry>()

function makePollEntry(cardId: string): PollEntry {
  return { cardId, deadlineAt: Date.now() + maxExecutionMs(), retries: 0, unknowns: 0 }
}

let queueTail: Promise<void> = Promise.resolve()
const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

// Generation counter: incremented on reset. Async operations check this to abort early.
let generation = 0

function enqueue(fn: () => Promise<void>): void {
  queueTail = queueTail.then(fn).catch((err: unknown) => {
    console.error('[card-execution] unhandled queue error', err)
  })
}

export async function flushForTests(): Promise<void> {
  let prev: Promise<void>
  do {
    prev = queueTail
    await prev
  } while (queueTail !== prev)
}

export function resetQueueForTests(): void {
  for (const timer of pendingTimers) clearTimeout(timer)
  pendingTimers.clear()
  generation++
  queueTail = Promise.resolve()
  activePollJobs.clear()
}

// ─── Column helpers ───────────────────────────────────────────────────────────

function findColumn(columns: BoardColumn[], name: string): BoardColumn | undefined {
  return columns.find((c) => c.name.toLowerCase() === name.toLowerCase())
}

async function handleSuccessDelivery(
  project: string,
  cardId: string,
  result: PollResult,
): Promise<void> {
  const output = result.output ?? ''
  const parsed = parseDeliverableOutput(output)

  if (parsed.deliverables.length === 0 || parsed.finalCommit === null) {
    await postExecutionComment(cardId, `Claude Code finished.\n\n${output.slice(0, 4000)}`)
    await postProtocolWarningComment(cardId)
    return
  }

  const projectPath = await resolveProjectPath(project)
  if (projectPath === null) {
    await postExecutionComment(cardId, `Claude Code finished, but the project path for "${project}" could not be resolved. Artifacts not attached.`)
    return
  }

  const attached: Array<{ filename: string; artifactId: string }> = []
  const rejectedOrSkipped: Array<{ path: string; reason: string }> = []

  for (const delivPath of parsed.deliverables) {
    try {
      assertSafeDeliverablePath(delivPath)
    } catch (err) {
      rejectedOrSkipped.push({ path: delivPath, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    const attachResult = await attachDeliverableArtifact(cardId, projectPath, delivPath)
    if ('skipped' in attachResult) {
      rejectedOrSkipped.push({ path: delivPath, reason: attachResult.skipped })
    } else {
      attached.push({ filename: attachResult.filename, artifactId: attachResult.artifactId })
    }
  }

  await postDeliverySummaryComment(cardId, parsed.summary ?? '', attached, rejectedOrSkipped)
}

async function handleTerminal(
  execId: string,
  cardId: string,
  columns: BoardColumn[],
  state: string,
  result: PollResult
): Promise<void> {
  const prisma = await db()
  const isSuccess = state === 'done' && result.exitCode === 0
  const effectiveState = isSuccess ? 'done' : 'failed'
  const errorMsg = result.errorDetail ?? result.output ?? ''

  const updatedExec = await prisma.cardExecution.update({
    where: { id: execId },
    data: {
      state: effectiveState,
      output: result.output ?? null,
      errorMessage: isSuccess ? null : errorMsg.slice(0, 2000),
      finishedAt: new Date(),
    },
  })

  if (isSuccess) {
    const reviewCol = findColumn(columns, 'Review')
    if (reviewCol) {
      await prisma.card.update({ where: { id: cardId }, data: { columnId: reviewCol.id } })
    }
    await handleSuccessDelivery(updatedExec.project, cardId, result)
  } else {
    const blockedCol = findColumn(columns, 'Blocked')
    if (blockedCol) {
      await prisma.card.update({ where: { id: cardId }, data: { columnId: blockedCol.id } })
    }
    await postExecutionComment(cardId, `Claude Code failed: ${errorMsg.slice(0, 2000)}`)
  }
}

// Force-fails an execution that can no longer make progress (deadline exceeded,
// retries exhausted, or persistently-unknown state): marks the row failed,
// moves the card to Blocked so it is visible, posts a comment, and stops
// scheduling by removing the job from the active poll map.
async function failExecution(
  jobId: string,
  cardId: string,
  execId: string,
  columns: BoardColumn[],
  reason: string
): Promise<void> {
  activePollJobs.delete(jobId)
  const prisma = await db()
  await prisma.cardExecution.update({
    where: { id: execId },
    data: { state: 'failed', errorMessage: reason.slice(0, 2000), finishedAt: new Date() },
  })
  const blockedCol = findColumn(columns, 'Blocked')
  if (blockedCol) {
    await prisma.card.update({ where: { id: cardId }, data: { columnId: blockedCol.id } })
  }
  await postExecutionComment(cardId, `Claude Code failed: ${reason.slice(0, 2000)}`)
}

async function runPollTick(jobId: string, cardId: string, execId: string): Promise<void> {
  const gen = generation
  const prisma = await db()
  if (generation !== gen) return
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { board: { include: { columns: true } } },
  })
  if (!card) {
    console.warn(`[card-execution] card ${cardId} gone during polling, stopping`)
    activePollJobs.delete(jobId)
    return
  }

  // The job may have been removed (reset, completed, or failed) since this tick
  // was scheduled. If so, do not resurrect it.
  const entry = activePollJobs.get(jobId)
  if (!entry) return

  // Hard deadline: never poll a single execution forever.
  if (Date.now() >= entry.deadlineAt) {
    await failExecution(
      jobId,
      cardId,
      execId,
      card.board.columns,
      `Execution timed out after ${maxExecutionMs()}ms without reaching a terminal state.`
    )
    return
  }

  const mcp = await getMcpClient()

  // Wrap the poll call so a transient ClaudeMCP error reschedules with backoff
  // instead of permanently orphaning the execution. Bounded by MAX_POLL_RETRIES.
  let result: PollResult
  try {
    result = await mcp.pollClaudeJobStatus(jobId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    entry.retries += 1
    if (entry.retries > MAX_POLL_RETRIES) {
      await failExecution(
        jobId,
        cardId,
        execId,
        card.board.columns,
        `Polling failed after ${MAX_POLL_RETRIES} retries: ${msg}`
      )
      return
    }
    console.warn(`[card-execution] transient poll error (retry ${entry.retries}/${MAX_POLL_RETRIES})`, msg)
    scheduleDelayedPollTick(jobId, cardId, execId, POLL_RETRY_BACKOFF_MS)
    return
  }

  // Successful poll resets the transient-error counter.
  entry.retries = 0
  const { state } = result

  if (state === 'running') {
    entry.unknowns = 0
    const existing = await prisma.cardExecution.findFirst({
      where: { id: execId },
      select: { state: true },
    })
    if (existing?.state !== 'running') {
      await prisma.cardExecution.update({
        where: { id: execId },
        data: { state: 'running', startedAt: new Date() },
      })
      await postExecutionComment(cardId, 'Claude is now running.')
    }
    scheduleDelayedPollTick(jobId, cardId, execId, POLL_INTERVAL_MS)
    return
  }

  const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted'])
  if (terminal.has(state)) {
    activePollJobs.delete(jobId)
    await handleTerminal(execId, cardId, card.board.columns, state, result)
    return
  }

  // Unrecognised state. Tolerate a few in case the backend is transitioning,
  // but classify as failure after MAX_UNKNOWN_STATES consecutive unknowns so
  // we do not re-poll forever.
  entry.unknowns += 1
  if (entry.unknowns >= MAX_UNKNOWN_STATES) {
    await failExecution(
      jobId,
      cardId,
      execId,
      card.board.columns,
      `Execution stuck in unknown state '${state}' after ${MAX_UNKNOWN_STATES} polls.`
    )
    return
  }
  scheduleDelayedPollTick(jobId, cardId, execId, POLL_INTERVAL_MS)
}

// Used only for subsequent ticks after a non-terminal state (delay > 0).
function scheduleDelayedPollTick(jobId: string, cardId: string, execId: string, delay: number): void {
  const tickPromise = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer)
      runPollTick(jobId, cardId, execId)
        .catch((err: unknown) => console.error('[card-execution] poll tick error', err))
        .finally(resolve)
    }, delay)
    pendingTimers.add(timer)
  })
  queueTail = queueTail.then(() => tickPromise)
}

// Used for the first tick (delay=0) — chains directly onto queueTail as a microtask
// so flushForTests() can drain it without relying on macrotask ordering.
function enqueueImmediatePollTick(jobId: string, cardId: string, execId: string): void {
  enqueue(() => runPollTick(jobId, cardId, execId))
}

// ─── fireExecutionForCard ─────────────────────────────────────────────────────

export async function fireExecutionForCard(cardId: string): Promise<void> {
  const gen = generation
  const prisma = await db()
  if (generation !== gen) return

  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: {
      board: { include: { columns: true } },
      column: true,
    },
  })

  if (!card) return
  if (card.assigneeId !== 'agent-claude-code') return
  if (card.column.name.toLowerCase() !== 'in progress') return
  if (!card.description?.trim()) return

  const mcp = await getMcpClient()

  // Serialize the active-execution dedup check + the cardExecution.create per
  // card so two concurrent fires cannot both pass the "no active execution"
  // check and create duplicate Claude Code build jobs for one card. The lock
  // is released before submitClaudeBuild so the (slow) build submission is not
  // serialized — only the check-then-create critical section is protected.
  const prepared = await withKeyedLock<
    | { kind: 'aborted' }
    | { kind: 'blocked' }
    | { kind: 'ready'; execution: { id: string }; slug: string; branch: string; spec: string }
  >(`card-exec:${cardId}`, async () => {
    const activeExec = await prisma.cardExecution.findFirst({
      where: { cardId, state: { in: ['enqueued', 'running'] } },
    })
    if (activeExec) return { kind: 'aborted' }

    const slug = slugifyBoardName(card.board.name)
    const projects = await mcp.listClaudeProjects()

    if (!projects.includes(slug)) {
      const errorMessage =
        `No ClaudeMCP project named '${slug}'. Add an entry to /root/ClaudeMCP/projects.json and SIGHUP claude-mcp.`
      await prisma.cardExecution.create({
        data: {
          cardId,
          state: 'failed',
          project: slug,
          branch: `agent/card-${cardId.slice(-7)}`,
          spec: buildEnrichedSpec(card.title, card.description ?? ''),
          errorMessage,
          finishedAt: new Date(),
        },
      })
      const blockedCol = findColumn(card.board.columns, 'Blocked')
      if (blockedCol) {
        await prisma.card.update({ where: { id: cardId }, data: { columnId: blockedCol.id } })
      }
      await postExecutionComment(cardId, errorMessage)
      return { kind: 'blocked' }
    }

    const branch = `agent/card-${cardId.slice(-7)}`
    const spec = buildEnrichedSpec(card.title, card.description ?? '')

    const execution = await prisma.cardExecution.create({
      data: { cardId, state: 'enqueued', project: slug, branch, spec, enqueuedAt: new Date() },
    })

    return { kind: 'ready', execution, slug, branch, spec }
  })

  if (prepared.kind !== 'ready') return

  const { execution, slug, branch, spec } = prepared

  let jobResult: { jobId: string; state: string }
  try {
    jobResult = await mcp.submitClaudeBuild({ project: slug, spec, branch, runTests: false })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.cardExecution.update({
      where: { id: execution.id },
      data: { state: 'failed', errorMessage: msg.slice(0, 2000), finishedAt: new Date() },
    })
    const blockedCol = findColumn(card.board.columns, 'Blocked')
    if (blockedCol) {
      await prisma.card.update({ where: { id: cardId }, data: { columnId: blockedCol.id } })
    }
    await postExecutionComment(cardId, `Claude Code failed to submit: ${msg.slice(0, 2000)}`)
    return
  }

  await prisma.cardExecution.update({
    where: { id: execution.id },
    data: { jobId: jobResult.jobId },
  })

  await postExecutionComment(cardId, `Claude Code started working on this card.\nProject: ${slug}\nBranch: ${branch}\nJob: ${jobResult.jobId}`)

  activePollJobs.set(jobResult.jobId, makePollEntry(cardId))
  enqueueImmediatePollTick(jobResult.jobId, cardId, execution.id)
}

// ─── bootstrapWorker ─────────────────────────────────────────────────────────

export async function bootstrapWorker(): Promise<void> {
  const prisma = await db()

  const inFlight = await prisma.cardExecution.findMany({
    where: { state: { in: ['enqueued', 'running'] }, jobId: { not: null } },
  })
  for (const exec of inFlight) {
    if (!exec.jobId) continue
    activePollJobs.set(exec.jobId, makePollEntry(exec.cardId))
    enqueueImmediatePollTick(exec.jobId, exec.cardId, exec.id)
  }

  const cutoff = new Date(Date.now() - DEBOUNCE_MS)
  const candidates = await (
    prisma.card as unknown as {
      findMany: (args: unknown) => Promise<
        Array<{
          id: string
          assigneeId: string
          description: string | null
          updatedAt: Date
          column: { name: string }
        }>
      >
    }
  ).findMany({
    where: {
      assigneeId: 'agent-claude-code',
      description: { not: '' },
      updatedAt: { lte: cutoff },
      executions: { none: { state: { in: ['enqueued', 'running'] } } },
    },
    include: { column: { select: { name: true } } },
  })

  for (const c of candidates) {
    if (c.column.name.toLowerCase() !== 'in progress') continue
    if (!c.description?.trim()) continue
    enqueue(() => fireExecutionForCard(c.id))
  }
}
