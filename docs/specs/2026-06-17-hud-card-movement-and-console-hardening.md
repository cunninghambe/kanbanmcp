# HUD Card-Movement Awareness + Background-Error Hardening

**Status:** Design — pending approval
**Date:** 2026-06-17
**Branch:** `feat/hud-card-movement` (off `claude/meeting-copilot-hud-x4o2zr` / draft PR #33)
**Author:** Claude (brainstormed with Brad)
**Supersedes/extends:** `docs/specs/host-meeting-hud-addendum.md` (MEETINGCOPILOTSPEC)

---

## Problem Statement

The Host Meeting HUD dispatches read-only agents to answer questions about a board during a
live meeting. Today the agent receives only a **point-in-time** board snapshot — current cards,
their column, priority, due date, assignee. It has no history. So temporal questions like the
stock prompt *"Which cards moved since last week?"* are unanswerable: the agent correctly reports
it cannot determine movement because nothing in the system records when a card changes column.
Separately, the HUD's client pages emit background errors to the browser console (failed
fetches / EventSource reconnect spam / silently-swallowed dispatch failures) that are never
surfaced to the user. This spec adds a card-movement audit trail and surfaces it to the HUD
agent, and hardens the HUD client so background failures are either handled or shown.

This work targets the operator (meeting chair) using the HUD, and the read-only agents that
serve their questions.

---

## Boundaries

**This DOES:**
- Add a `CardMovement` audit record written whenever a card's `columnId` changes, at **every**
  write site (UI/API PATCH, MCP `move_card`, ChangeSet apply).
- Inject a "Recent movements" section into the HUD board snapshot (`buildBoardContext`).
- Add a read-only `list_card_movements` MCP tool so agents can query history on demand.
- Harden the HUD client: surface dispatch failures, stop EventSource reconnect spam, stop SWR
  retry storms on permanently-failing endpoints.

**This does NOT:**
- Backfill historical movement. There is no source data; movement answers are only correct for
  moves that occur **after** this ships. The spec must make agents state this limitation when the
  window predates the feature's deploy.
- Record non-column edits (title/priority/assignee changes) as movements — only column changes.
- Record initial card placement as a "move" (a new card has no prior column). "Time in current
  column" for a never-moved card derives from `Card.createdAt`.
- Track intra-column position/reorder changes (not a "move" for meeting purposes).
- Add a movement UI/timeline view (out of scope; agent-surfacing only for v1).

**External dependencies:** none new. Reuses Prisma, the existing MCP tool framework, SWR,
EventSource. No new npm packages.

---

## Architecture Decision

- **New model, not reuse of `AgentActivity`.** `AgentActivity` is a generic, org-scoped JSON log
  primarily for agent actions; querying it for movements ("filter action=move_card, JSON-parse
  metadata, resolve columns") is fragile and unindexed for this access pattern. A dedicated
  `CardMovement` table with typed columns and `[cardId, movedAt]` / `[boardId, movedAt]` indexes
  is the right shape for the "movements on board B since date D" query the HUD needs.
- **Shared recorder helper, not a unified move service.** Rather than refactor all three move
  paths into one `moveCard()` service (large blast radius; risks regression per the
  trajectory-erosion concern in CLAUDE.md), add one small pure-ish helper
  `recordCardMovement(tx, input)` called from each existing site inside its existing transaction.
- **Snapshot injection + MCP tool, both.** The snapshot answers the stock prompt with zero agent
  round-trips; the MCP tool lets agents pull arbitrary windows/cards on demand (matches the
  tool-oriented design the agent itself referenced).
- **File placement:** `src/lib/card-movement.ts` (service + context formatter), schema addition in
  `prisma/schema.prisma`, MCP tool in `src/lib/mcp-server.ts`, snapshot change in
  `src/lib/host-hud/worker.ts`. Client fixes in `src/hooks/useHudStream.ts` and
  `src/app/(app)/hud/[id]/page.tsx`.

---

## Track 1 — Card Movement Audit Log

### Data Model (`prisma/schema.prisma`, additive)

```prisma
model CardMovement {
  id           String   @id @default(cuid())
  cardId       String
  boardId      String
  orgId        String
  fromColumnId String?  // null only if a move is recorded with no known prior column
  toColumnId   String
  movedById    String   // a userId, or an agent label e.g. "Host Meeting HUD"
  movedByKind  String   // "user" | "agent" — disambiguates movedById
  movedAt      DateTime @default(now())

  card  Card  @relation(fields: [cardId], references: [id], onDelete: Cascade)
  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([cardId, movedAt])
  @@index([boardId, movedAt])
  @@index([orgId, movedAt])
  @@map("card_movements")
}
```
Back-relations added: `Card.movements CardMovement[]`, `Board.movements CardMovement[]`.
Applied via the box's boot-time `prisma db push` (see schema-sync-on-boot); purely additive →
new table only, no data loss.

### Recorder (`src/lib/card-movement.ts`)

```ts
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
): Promise<{ id: string } | null>
```

### Write sites (each wraps move + record in one transaction)

1. **`src/app/api/cards/[cardId]/route.ts` (PATCH).** Currently the move happens inside a
   `$transaction` but the route never reads the prior `columnId` and never logs. Change: inside
   the transaction, before `tx.card.update`, read the card's current `columnId`; after the update,
   if `columnId` was provided and differs, call `recordCardMovement(tx, …)` with
   `movedBy = { id: session.userId, kind: 'user' }`.
2. **`toolMoveCard` in `src/lib/mcp-server.ts`.** Already loads `existing.columnId` and logs
   `move_card` activity. Wrap the `prisma.card.update` + `recordCardMovement` in a
   `prisma.$transaction`; `movedBy = { id: agentCtx.agentName, kind: 'agent' }`.
3. **ChangeSet apply (`src/lib/changesets.ts`, the `move_card` op path).** When an approved
   `move_card` op executes, call `recordCardMovement` in the same transaction;
   `movedBy = { id: 'Host Meeting HUD', kind: 'agent' }`.

### Snapshot injection (`src/lib/host-hud/worker.ts`)

`buildBoardContext` gains a trailing section. New helper in `card-movement.ts`:

```ts
export async function formatRecentMovements(
  prisma: PrismaClient,
  args: { boardId: string; orgId: string; sinceDays?: number; limit?: number }
): Promise<string>   // '' when there are no movements in-window
```
Defaults: `sinceDays = 14`, `limit = 200` (newest first). Output lines resolve column + card
names, e.g.:
```
Recent movements (last 14 days):
  - "Get Spoonworks running": In Progress → Review on 2026-06-14 by Brad
  - "Business concept research": Backlog → Review on 2026-06-11 by Host Meeting HUD
```
When the requested window starts earlier than the earliest `movedAt` on record for that board
(i.e. we have no data covering the full window), append a one-line note stating movements before
that earliest recorded date are not tracked, so the agent qualifies its answer instead of implying
completeness. This is computed from the data (no hardcoded deploy date).

### Read-only MCP tool (`src/lib/mcp-server.ts`)

Add to `MCP_TOOLS`, `TOOL_HANDLERS`, and implement `toolListCardMovements`. Read-only → no
`WRITE_TOOLS` entry (any scoped key may call it). Org-scoped via `agentCtx.orgId`.

```
name: 'list_card_movements'
description: 'List column-change history for a board (or a single card), newest first.
  Only records moves made after this feature was deployed — there is no historical backfill.'
inputSchema: {
  boardId?: string      // one of boardId | cardId required
  cardId?:  string
  sinceDays?: number    // default 14, max 90
  limit?:    number     // default 50, max 200
}
```
Returns `{ movements: Array<{ cardId, cardTitle, fromColumn, toColumn, movedBy, movedByKind,
movedAt }>, truncated: boolean }`, with `boardId`/`cardId` validated against `agentCtx.orgId`
(throw `-32602` "not found or access denied" on mismatch, matching existing tools).

---

## Track 2 — HUD Background-Error Hardening

**Step 0 (first task): reproduce in the real browser.** Drive the live HUD via camofox, open the
console, walk the no-name / start / stock-prompt flow, and capture the actual console output.
Confirm which of the sources below fires before fixing. (Note the camofox caveat: it suppresses
uncaught `window.onerror`; rely on console.error / network capture and a positive-control
self-test.)

**Confirmed code-level sources to fix:**

1. **EventSource reconnect spam — `src/hooks/useHudStream.ts`.** `onerror` only clears the ref on
   `CLOSED`; the browser auto-reconnects on transient/permanent failures, logging each attempt.
   Fix: on a non-transient error (e.g. server closed / 4xx), explicitly `es.close()` and stop;
   ensure `/api/hud/[id]/events` returns a definitive close (not a 500 loop) for non-live /
   not-found / unauthorized sessions so the browser stops retrying.
2. **Swallowed dispatch failures — `src/app/(app)/hud/[id]/page.tsx` `dispatch()`.** `if (res.ok)
   mutate()` has no `else`; a failed dispatch shows nothing. Fix: add an error state and surface a
   user-visible message (inline/toast) on `!res.ok` and on network throw. Per CLAUDE.md, define
   loading / empty / error / success for this action.
3. **SWR retry storm — same file's three `useSWR` fetchers.** The shared `fetcher` throws on
   `!r.ok`; permanently-failing routes (e.g. 403/404) retry on a backoff forever. Fix: configure
   `shouldRetryOnError` / `onErrorRetry` to stop on permanent statuses, and render a quiet degraded
   state rather than spamming.

---

## Edge Cases

| # | Scenario | Required behavior |
|---|----------|-------------------|
| E1 | PATCH updates a card but not `columnId` (rename/priority only) | No `CardMovement` row written |
| E2 | `columnId` provided but equals current column | No row (recorder no-ops) |
| E3 | Move + other fields in one PATCH | Exactly one movement row; other fields update normally |
| E4 | Card moved by an MCP agent | Row with `movedByKind='agent'`, `movedById=agentName` |
| E5 | Card moved via approved ChangeSet | Row with `movedById='Host Meeting HUD'`, kind `agent` |
| E6 | Card deleted later | Movement rows cascade-delete with the card |
| E7 | Window start precedes the earliest recorded movement for the board | Snapshot/tool append the "not tracked before <earliest date>" note |
| E8 | Board with zero in-window movements | `formatRecentMovements` returns `''`; snapshot omits the section |
| E9 | `list_card_movements` with neither boardId nor cardId | `-32602` validation error |
| E10 | `list_card_movements` for another org's board/card | `-32602` "not found or access denied" |
| E11 | Move transaction fails after card update but before record (or vice-versa) | Atomic: both commit or neither (same `$transaction`) |
| E12 | `sinceDays`/`limit` over max | Clamped (90 / 200) |
| E13 | Concurrent moves of the same card | Each records its own row; ordering by `movedAt` |
| B1 | Dispatch POST returns 400/500 | User sees an error message; no silent swallow |
| B2 | `/events` 404s for a missing session | EventSource closes, no console reconnect spam |
| B3 | A polling endpoint 403s | SWR stops retrying; degraded state shown, console quiet |

---

## Acceptance Criteria

- **AC1** Given a card in "In Progress", when it is moved to "Review" via PATCH, a single
  `card_movements` row exists with `fromColumnId`=InProgress, `toColumnId`=Review,
  `movedById`=actor userId, `movedByKind`='user'.
- **AC2** Given a PATCH that changes only the title, when applied, zero new `card_movements` rows
  are created.
- **AC3** Given a move via the MCP `move_card` tool, a row with `movedByKind='agent'` is recorded
  in the same transaction as the card update.
- **AC4** Given a move via an approved ChangeSet, a row with `movedById='Host Meeting HUD'` is
  recorded.
- **AC5** Given ≥1 in-window movement on the session's board, the HUD board snapshot contains a
  "Recent movements" section listing them with column names and dates; given none, the section is
  absent.
- **AC6** Given the stock prompt "Which cards moved since last week?", the dispatched agent's
  answer cites at least one recorded movement (when one exists in-window) instead of reporting it
  cannot determine movement.
- **AC7** Given `list_card_movements` called with a `boardId` belonging to the caller's org, it
  returns that board's movements newest-first, clamped to limits; with a foreign board it returns
  a `-32602` error.
- **AC8** Given a failed dispatch (non-2xx), the HUD session page displays a user-visible error and
  the console shows no unhandled rejection.
- **AC9** Given a non-live/missing session, the HUD session page does not produce repeating
  EventSource errors in the browser console (verified in-browser).

---

## Testing

Per Brad's contract-shape rule (positive, negative/FP-boundary, ≥2 edge, input-degradation):

- **`recordCardMovement`** (unit): writes correct row (positive); no-op on equal columns
  (negative/boundary); null `fromColumnId` accepted (edge); missing/garbage actor rejected by types
  + a runtime guard test (degradation).
- **Write sites** (integration): PATCH move writes exactly one row (E1–E3); MCP move (E4);
  ChangeSet apply (E5); atomicity (E11) by forcing the record to throw and asserting the card
  update rolled back.
- **`formatRecentMovements`** (unit): renders lines with names (positive); empty string when none
  (E8); window filtering excludes older rows (edge); pre-deploy note appended (E7); clamp (E12).
- **`list_card_movements`** (integration): board query (positive), foreign-org (E10), neither id
  (E9), clamps (E12).
- **Client hardening**: dispatch error surfaced (B1) via Testing Library; SWR no-retry on 403 (B3);
  EventSource teardown asserted on permanent error (B2, unit on the hook).
- Reuse the lazy-`db()` memoization pattern noted in the security-audit memory for any new
  per-call dynamic import to avoid the vitest module-mock race.

## Verification gate (per CLAUDE.md)

`npx tsc --noEmit` · `npx eslint . --max-warnings 0` · `npx vitest run` · `npm run build`, plus an
in-browser confirmation of AC8/AC9 against the running app before merge.

## Rollout

Build + verify in the `feat/hud-card-movement` worktree, then deploy to `/opt/kanban` the same way
PR #33 was deployed (checkout → `prisma generate` → `next build` → `pm2 restart kanban`, which
`db push`es the new table). No env changes. Rollback = redeploy the prior branch.
