# M2: Claude Code task execution

## Status
SHIPPED 2026-05-20 in commit `2b8defd1` ("M2 + M3 + UI redesign: claude execute, deliverables, design system").

Audit: [`docs/specs/m2/AUDIT.md`](./m2/AUDIT.md) — verdict SHIPPED-WITH-DRIFT (10/12 AC PASS, 2 intentional column-order drifts now reflected in this doc, 1 defense-in-depth gap in `deliverables.ts` flagged for follow-up).

## Problem statement

A card assigned to the "Claude Code" agent should be executed by Claude Code when a human moves it to "In Progress". Today, moving a card does nothing — the AI integration in M1 covers *review* (rubric critique of descriptions/artifacts) but not *execution*. M2 closes the loop: card → claude_build job at ClaudeMCP → branch with implementation → human reviewer.

## Boundaries

### In scope
- Column-move trigger with a 60-second debounce (timer resets on any column change while pending)
- One `claude_build` submission per card per debounce-elapse
- Board-name → ClaudeMCP project mapping (slugify board name; lookup via `claude_list_projects`)
- New "Blocked" column auto-added to every board (existing boards via migration, new boards via updated `DEFAULT_COLUMNS`)
- New `card_executions` table tracking jobId, state, branch, spec snapshot, output, error
- Status updates posted as comments under the existing `agent-claude-code` user
- Auto-move card on terminal state: `done` → "Review" column if it exists; `failed`/`cancelled`/`interrupted` → "Blocked" column if it exists
- Resilience: timers lost on process restart are recovered by a boot-time sweep; in-flight jobs reattach polling via `bootstrapWorker` pattern

### Out of scope
- Multi-repo per board / per-card project overrides
- Concurrency caps (ClaudeMCP queues per-project; that's enough)
- Cancelling a running ClaudeMCP job when the card is moved out
- Re-running a card after success or failure (manual via deleting the `card_executions` row or the card)
- Per-card `claude_build` options (branch override, baseBranch, timeoutMs) — defaults only
- UI to surface execution state beyond the card-comments stream (M3 if wanted)
- Permissions UI to restrict who can trigger (any MEMBER can move cards = any MEMBER can trigger)

## Interface contract

### Prisma model

```prisma
model CardExecution {
  id            String   @id @default(cuid())
  cardId        String
  card          Card     @relation(fields: [cardId], references: [id], onDelete: Cascade)

  jobId         String?  // null while debounce-pending or before MCP submit
  state         CardExecutionState

  project       String   // ClaudeMCP project name used (slug of board.name)
  branch        String   // branch name passed to claude_build, e.g. agent/card-<suffix>
  spec          String   // card title + description snapshot at trigger time

  output        String?  // claude_build final output (commit SHA, summary)
  errorMessage  String?

  enqueuedAt    DateTime @default(now())
  startedAt     DateTime?
  finishedAt    DateTime?

  @@index([cardId])
  @@index([state])
}

enum CardExecutionState {
  enqueued       // CardExecution row created, MCP job submitted, awaiting status
  running        // ClaudeMCP reports state=running
  done
  failed
  cancelled
  interrupted
}
```

The 60-second debounce window itself is **not** stored in this table — it lives in an in-memory `Map<cardId, NodeJS.Timeout>`. Row creation happens at fire-time, not at trigger-time.

### Trigger hook

In `PATCH /api/cards/[cardId]/route.ts`, after a successful column-update commit, call:

```ts
import { maybeStartExecutionDebounce } from '@/lib/card-execution/triggers'
// ...
await maybeStartExecutionDebounce({
  cardId,
  prevColumnName: oldColumn.name,
  newColumnName: newColumn.name,
  assigneeId: updatedCard.assigneeId,
})
```

`maybeStartExecutionDebounce` is fire-and-forget (no await needed for HTTP response, but await is fine because the function is cheap — just timer manipulation).

**Trigger logic** (full table):

| New column | Assignee | Description | Active CardExecution? | Action |
|---|---|---|---|---|
| "In Progress" (case-insensitive match) | `agent-claude-code` | non-empty | none | Cancel any existing timer, start new 60s timer |
| "In Progress" | `agent-claude-code` | empty | none | Cancel any existing timer. Do not start. (Recoverable — user can add description and move out/back in.) |
| "In Progress" | `agent-claude-code` | any | active (enqueued/running) | Cancel any existing timer. No action. (Idempotent — don't queue duplicate.) |
| "In Progress" | not `agent-claude-code` | any | any | Cancel any existing timer. |
| Anything else | any | any | any | Cancel any existing timer. |

### Worker

`src/lib/card-execution/worker.ts` mirrors `src/lib/ai-review/worker.ts`:

```ts
// Public surface
export async function fireExecutionForCard(cardId: string): Promise<void>
export async function bootstrapWorker(): Promise<void>
export async function flushForTests(): Promise<void>  // tests only
export function resetQueueForTests(): void            // tests only
```

`fireExecutionForCard` is what the debounce timer invokes when it elapses. It:
1. Re-checks invariants (still in In Progress, still assigned to Claude Code, still no active execution, description still non-empty) — anything else changed during the 60s = abort silently.
2. Resolves project via `slugifyBoardName(board.name)` and verifies it's in the ClaudeMCP project registry. If missing → create CardExecution row with state=`failed`, error message, move card to Blocked, post comment, return.
3. Creates CardExecution row with state=`enqueued`, captures `spec = card.title + '\n\n' + card.description`, `branch = agent/card-<last8charsOfCardId>`.
4. Calls ClaudeMCP `claude_build`. On HTTP error → row state=`failed`, error captured, move to Blocked, comment, return.
5. Stores returned `jobId` on the row. Posts "Claude Code started working on this card. Project: `<slug>`. Branch: `<branch>`. Job: `<jobId>`." comment.
6. Enqueues a polling loop for this jobId.

The polling loop runs `claude_job_status` every 5 seconds. On state transitions:
- `running` (first time): post comment "Claude is now running.", update row.
- `done`: post comment with full `output`. Update row, set `finishedAt`. Move card to Review column if one exists on the board.
- `failed`/`cancelled`/`interrupted`: post comment with truncated error. Update row, set `finishedAt`. Move card to Blocked column if one exists on the board.

### ClaudeMCP client

`src/lib/card-execution/mcp-client.ts` — small wrapper that reuses the same JSON-RPC + `event: message\ndata: {…}` parsing already proven in `src/lib/ai-review/claude-client.ts:postClaudeMCP`. Factor that helper to `src/lib/mcp/http-client.ts` and import from both, or duplicate (preferred — only ~30 lines, avoids cross-cutting churn).

Functions:
- `submitClaudeBuild({ project, spec, branch, baseBranch?, runTests?, timeoutMs? }): Promise<{ jobId: string; state: string }>`
- `pollClaudeJobStatus(jobId): Promise<{ state, output?, errorDetail?, exitCode?, sessionId?, branch?, commitSha? }>`
- `listClaudeProjects(): Promise<string[]>` (slug names)

Env reads same vars as the review path: `CLAUDEMCP_URL`, `CLAUDEMCP_PROJECT` is **ignored** here (we use board-derived project), `CLAUDEMCP_TIMEOUT_MS` reused for job timeouts.

### Project slug + cache

`src/lib/card-execution/projects.ts`:

```ts
export function slugifyBoardName(name: string): string
// lowercase, replace any run of [^a-z0-9] with '-', trim leading/trailing '-'

export async function isProjectRegistered(slug: string): Promise<boolean>
// 60s in-memory cache of listClaudeProjects results
```

### Boot-time sweep (timer recovery)

In `bootstrapWorker`:

1. Reattach polling for `CardExecution where state in (enqueued, running)`.
2. Sweep: find cards where:
   - assigneeId = `agent-claude-code`
   - the card's column is named "In Progress" (case-insensitive)
   - no `CardExecution` with state in (enqueued, running) for this card *(the original spec also disqualified `done` and constrained by "since updatedAt"; shipped implementation broadens the filter: any not-actively-running prior execution is allowed to retrigger. This better matches the §E5 intent ("treat as new — start timer"). See `AUDIT.md` finding S2.)*
   - `description` non-empty
   - `(now - updatedAt) >= 60s`
   - Effect: call `fireExecutionForCard(cardId)` immediately.

Acknowledged precision tradeoff: `updatedAt` advances on any edit, not just column move. If a user enters In Progress and then edits the title 50s later, the 60s clock resets via this proxy. Acceptable for M2; revisit if it causes pain.

### Column naming convention

Match by exact case-insensitive name on `column.name`:
- Trigger column: "In Progress"
- Success column: "Review"
- Failure column: "Blocked"

If a board has been customized (rename / reordering), the trigger and auto-move behave according to the *names*, not positions. If "Review" or "Blocked" don't exist on a particular board, the auto-move is skipped (comment still posted).

### Migration

Single Prisma migration:
1. Create `card_executions` table + enum.
2. For every existing `boards` row, insert a new `columns` row `{ name: 'Blocked', position: (max position on board) + 1, boardId }` if no "Blocked" column already exists on that board (case-insensitive).
3. Update `DEFAULT_COLUMNS` in `src/app/api/orgs/[orgId]/boards/route.ts` to include `{ name: 'Blocked', position: 4 }` after Done (or before — see Brad's question below).

**Decision logged**: ~~append "Blocked" at the end (position 4 after Done)~~. **Superseded during implementation 2026-05-20:** `DEFAULT_COLUMNS` ships with `Blocked` at position 3 and `Done` at position 4. Final order: `Backlog (0), In Progress (1), Review (2), Blocked (3), Done (4)`. Rationale (per commit `2b8defd1` message): "Blocked sits before Done so failures don't terminate the row." The migration SQL still appends at `max(position) + 1` (so for any board that was created before the new `DEFAULT_COLUMNS` landed and was never re-seeded, Blocked is the trailing column); all currently live boards have been re-created/re-seeded through the new `DEFAULT_COLUMNS` path and show the Blocked-before-Done order.

## Edge cases (full enumeration)

| # | Case | Behavior |
|---|---|---|
| E1 | Card moves In Progress → Backlog → In Progress within 60s | Timer reset twice; one execution fires 60s after final entry |
| E2 | Description empty when timer fires | Don't enqueue. No CardExecution row. No Blocked-move. (Recoverable: edit + retrigger.) Post comment to that effect? Per spec discussion: no comment — empty description means user isn't ready, don't spam. |
| E3 | Board name doesn't map to any ClaudeMCP project | CardExecution row stored with state='failed', error="No ClaudeMCP project named '<slug>'. Add an entry to /root/ClaudeMCP/projects.json and SIGHUP claude-mcp." Card → Blocked. Comment posted. |
| E4 | Card already has an active CardExecution (state enqueued/running) | Don't enqueue duplicate. Don't even start the timer. |
| E5 | Card has a terminal CardExecution (done/failed/...) and re-enters In Progress | Treat as new — start timer, fire new execution. (User opt-out: delete the prior row.) |
| E6 | ClaudeMCP HTTP unreachable at submit time | CardExecution.state='failed'. Move to Blocked. Comment with the network error. |
| E7 | Process restart mid-debounce | Lost. Boot-time sweep recovers (see "Boot-time sweep" above). |
| E8 | Process restart mid-job (state=running) | `bootstrapWorker` resumes polling via stored jobId. |
| E9 | Review or Blocked column missing on board | Skip the auto-move. Still post comment. |
| E10 | Same board name in two orgs | Both map to the same ClaudeMCP project. Per Brad: acceptable. |
| E11 | Card deleted while job is running | `CardExecution` cascades on delete. Polling loop checks for cardId presence before posting comments; if gone, log + abandon poll. |
| E12 | ClaudeMCP returns `done` but `exitCode != 0` (build/test failure) | Treat as `failed`. Move to Blocked. Comment includes the output (which contains the failure detail). |
| E13 | `description` contains injection-looking content (e.g. `</prompt>`) | Pass through as-is to `spec` field. ClaudeMCP doesn't interpret system-style boundaries from arbitrary strings. No special handling required. |
| E14 | Two cards on the same board both trigger in the same minute | ClaudeMCP queues per-project. Both jobs submit; second waits for first to release the project. No app-side change needed. |
| E15 | Card's column gets renamed mid-debounce (e.g. user renames "In Progress" to "WIP") | Timer is keyed by cardId, not column. When timer fires, the invariant check sees the column no longer matches "In Progress" → abort silently. Reasonable. |

## Acceptance criteria

1. **Happy path** — Given a card with description, assignee=Claude Code, in "Backlog" → user moves to "In Progress" → after 60s, a `CardExecution` row exists with `state in (enqueued, running)`, a comment "Claude Code started working…" is posted, and ClaudeMCP has received the `claude_build` job.
2. **Debounce cancellation** — Given a card moved to In Progress then to Backlog within 60s, no `CardExecution` row is created and no `claude_build` is submitted.
3. **Debounce reset** — Given a card moved In Progress → another column → In Progress within 30s, the timer resets and fires 60s after the final entry.
4. **Successful job** — Given a `claude_build` job that reaches `state=done` with `exitCode=0`, the card moves to "Review" column (if present), a comment is posted containing the branch name and output, and `CardExecution.state='done'`.
5. **Failed job** — Given a `claude_build` job that reaches `state=failed` (or `done` with `exitCode != 0`), the card moves to "Blocked" column (if present), a comment containing the error is posted, and `CardExecution.state='failed'`.
6. **Unmapped board** — Given a card on a board whose slugified name has no matching ClaudeMCP project, the card moves to Blocked, a comment explains the missing mapping, no `claude_build` is submitted, `CardExecution.state='failed'`.
7. **Restart resilience (debounce)** — Given a process restart while a card has been in In Progress for 80s (no execution yet), the boot-time sweep enqueues the execution within 10s of the worker bootstrapping.
8. **Restart resilience (job)** — Given a process restart while a job is in `state=running`, polling resumes within 5s of boot and the card reaches a terminal state when ClaudeMCP finishes.
9. **Migration** — After applying the migration, every existing board has a "Blocked" column appended at `max(position) + 1`. Existing card positions on existing columns are unchanged. (Live DB note: all currently live boards have been re-seeded through `DEFAULT_COLUMNS` post-migration and now show order `Backlog (0), In Progress (1), Review (2), Blocked (3), Done (4)` — see §Migration "Decision logged" for the rationale on the position swap.)
10. **New board creation** — Creating a new board via `POST /api/orgs/[orgId]/boards` produces five columns in this order: Backlog (0), In Progress (1), Review (2), Blocked (3), Done (4).
11. **Duplicate prevention** — Given a card already with `CardExecution.state='enqueued'`, moving it out and back in does **not** create a second CardExecution.
12. **Empty description** — Given a card with empty description, moving to In Progress fires no execution and creates no row; no comment is posted.

## Architecture decision

- New module: `src/lib/card-execution/` mirrors `src/lib/ai-review/`
  - `worker.ts` — fireExecutionForCard, bootstrapWorker, polling loop
  - `mcp-client.ts` — claude_build / claude_job_status / claude_list_projects wrappers
  - `triggers.ts` — maybeStartExecutionDebounce, in-memory `Map<cardId, NodeJS.Timeout>`
  - `projects.ts` — slugifyBoardName, isProjectRegistered with 60s cache
  - `comments.ts` — postExecutionComment helper (uses `agent-claude-code` userId)
- Worker boot called from `instrumentation.ts` alongside the existing `ai-review` worker boot.
- One PATCH hook in `src/app/api/cards/[cardId]/route.ts`, post-commit on column change.
- One Prisma migration that creates table+enum and adds Blocked column to existing boards in a single transaction.
- One small constant change to `src/app/api/orgs/[orgId]/boards/route.ts`'s `DEFAULT_COLUMNS`.

No structural refactoring of `ai-review/` is required. The two modules are siblings.

## Open / deferred

- **Surface execution state in the card UI** beyond comments (badge on card, dedicated "Execution" panel in CardModal) — punt to M3.
- **Cancel button on the card** to call `claude_job_cancel` — punt to M3.
- **Re-run** button — punt to M3.
- **Branch link** in comment as a clickable URL — needs the host/repo of the project. Punt; comment text with `agent/card-xxxxxxxx` is enough for now.
- **Per-board overrides** — punt indefinitely unless user-needed.
