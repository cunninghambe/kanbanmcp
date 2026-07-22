# Spec: Host Meeting HUD — dispatch hardening

**Date:** 2026-07-13 · **Branch:** `fix/hud-hardening` · **Status:** confirmed, implementing
**Relation:** hardens the "as built" HUD in `docs/specs/host-meeting-hud-addendum.md` §9.
Owner-authored (the controller intentionally left design to the implementer).

---

## 1. Problem Statement

The Host Meeting HUD lets a meeting chair dispatch read-only AI agents (via the
external ClaudeMCP job server) to answer questions live. Seven observed behaviors
make the feature abusable, cost-unbounded, or unsafe: unbounded question text and
board context inflate every external LLM prompt; nothing caps concurrent in-flight
dispatches (each a real, paid ClaudeMCP job); cancelling or ending a session stops
the local poll loop but leaves the external job running; model-supplied citation
URLs are rendered directly as anchor `href`s (script-URL vector); and email/Slack
target chips are always shown even when the external agent has no such access,
producing confusing mid-meeting failures. This workstream bounds inputs, caps
concurrency, propagates cancellation, sanitizes rendered URLs, and gates targets
by deployment configuration — without changing the trust model (agents propose,
humans approve; no live board mutation).

## 2. Boundaries

**In scope (the seven findings):**
1. Bound `question` length at the dispatch route (zod `.max`).
2. Cap concurrent in-flight dispatches per HUD session and per org.
3. Bound the serialized board context (cards per column + total chars).
4. Propagate cancellation to ClaudeMCP via its `claude_job_cancel` tool.
5. Ending a session cancels its in-flight dispatches (→ finding 4 propagation).
6. Sanitize citation `url` values (parse-time drop + render-time guard).
7. Capability-gate targets via `HUD_ENABLED_TARGETS` (server enforced + client
   chip gating through a new read-only config route).

**Explicitly NOT in scope:**
- No schema/migration changes (findings need none). No new npm dependencies.
- No changes to the trust model, ChangeSet apply path, MCP permission model, or
  the streaming hook.
- No edits to files owned by the parallel `feat/hud-meeting-manager` branch
  (`SituationRail.tsx`, the HUD page layout `hud/[id]/page.tsx`, changesets
  routes). Capability gating is delivered so `AgentConsole` self-fetches config
  rather than requiring a new prop threaded through the page.
- Distributed correctness of the concurrency cap (see Edge Cases E2).

**External dependencies:** ClaudeMCP at `CLAUDEMCP_URL` exposing `claude_run`,
`claude_job_status`, and (now used) `claude_job_cancel` (verified present at
`/root/ClaudeMCP/src/tools/jobCancel.ts`; SIGTERM→SIGKILL a running job's PID).

## 3. Interface Contract

### New module `src/lib/host-hud/config.ts` (env-driven tuning; no I/O beyond `process.env`)
```ts
export const MAX_QUESTION_LENGTH = 2000            // chars
export const MAX_CARDS_PER_COLUMN = 40             // cards serialized per column
export function maxBoardContextChars(): number     // env HUD_BOARD_CONTEXT_MAX_CHARS, default 16000, min 500
export function maxInflightPerSession(): number    // env HUD_MAX_INFLIGHT_PER_SESSION, default 3, min 1
export function maxInflightPerOrg(): number         // env HUD_MAX_INFLIGHT_PER_ORG, default 8, min 1
export function hudEnabledTargets(): DispatchTarget[]  // env HUD_ENABLED_TARGETS (csv); unset/garbage → all four
export function isTargetEnabled(t: DispatchTarget): boolean
```

### `src/lib/host-hud/dispatch.ts` (pure)
```ts
// New, exported, pure. Returns a safe href or undefined.
export function sanitizeCitationUrl(raw: unknown): string | undefined
// http:, https:, mailto: only; must be an absolute URL; else undefined.
// parseDispatchAnswer() runs every citation.url through it before returning.
```

### `src/lib/host-hud/worker.ts`
```ts
// New, exported, pure. Caps cards/column and total length.
export function renderBoardContext(
  board: { name: string; id: string; columns: Array<{
    name: string; id: string;
    cards: Array<{ id: string; title: string; priority: string; dueDate: Date | null }>
  }> },
  movements: string | undefined,
  opts: { maxCardsPerColumn: number; maxChars: number },
): string
// buildBoardContext() now: prisma include takes MAX_CARDS_PER_COLUMN+1 cards/col,
// then calls renderBoardContext(...). On chair-cancel detected mid-poll, the worker
// calls mcp().cancelDispatch(jobId) (best-effort) before returning.
```

### `src/lib/host-hud/mcp-client.ts`
```ts
export async function cancelDispatch(jobId: string): Promise<void>  // claude_job_cancel; best-effort
export type DispatchMcpClient = {
  submitDispatch: typeof submitDispatch
  pollDispatchStatus: typeof pollDispatchStatus
  cancelDispatch: typeof cancelDispatch   // added to the seam
}
```

### Routes
- `POST /api/hud/[id]/dispatch` — zod `question: z.string().min(1).max(MAX_QUESTION_LENGTH)`;
  reject disabled target (`isTargetEnabled`) with 400; enforce concurrency caps
  (per-session then per-org) with **429**; otherwise unchanged.
- `POST /api/hud/[id]/end` — after flipping to `ended`, `updateMany` the session's
  `{ status in [queued, running] }` dispatches → `cancelled` (+ `finishedAt`).
  Workers propagate to ClaudeMCP on their next poll.
- `GET /api/hud/config` — **new.** `requireSession` → `requireOrgRole(MEMBER)` →
  `{ enabledTargets: DispatchTarget[] }`. Read-only; no org scoping needed (global config).

### `src/app/(app)/hud/_components/AgentConsole.tsx`
- Self-fetches `/api/hud/config` (SWR). Chips not in `enabledTargets` render
  `disabled` with a title explaining why. Selected target auto-corrects to the
  first enabled target (preferring `board`) if the current one is disabled.
- Until config loads, optimistically treat all four as enabled (server still
  enforces).

### `src/app/(app)/hud/_components/DispatchCard.tsx`
- Citation anchors use `sanitizeCitationUrl(c.url)`; when it returns `undefined`,
  render the title/id as plain text (no anchor).

## 4. Edge Cases

- **E1 question length:** exactly `MAX_QUESTION_LENGTH` passes; `+1` → 400. Empty
  still → 400 (existing `.min(1)`). Multibyte counts as `String.length` (UTF-16
  units) — acceptable, documented.
- **E2 concurrency race:** two POSTs reading the count simultaneously can both pass
  (SQLite, non-transactional count). Cap is best-effort; a small transient
  overshoot is acceptable for a single-chair HUD. Documented, not locked.
- **E3 board context:** column with 0 cards → `(no cards)` unchanged; column with
  `>` cap cards → first `cap` + `… (more cards omitted)`; assembled string over
  `maxChars` → hard-truncated with `… [board context truncated]` marker; movements
  block included before truncation.
- **E4 cancel with no jobId yet:** dispatch cancelled before ClaudeMCP submit
  returns a jobId → nothing to propagate; worker returns cleanly. External job
  never existed. OK.
- **E5 cancel propagation failure:** `cancelDispatch` throws (job already gone /
  ClaudeMCP down) → swallowed; local status already `cancelled`. Never blocks.
- **E6 process restart window:** a dispatch cancelled while no worker polls it
  (e.g. between submit and a crash) is not re-enqueued (`bootstrapWorker` only
  takes `queued|running`), so its external job may run to completion. Known
  residual limitation — documented in code + `.env.example`.
- **E7 citation URL:** `https://x`/`http://x`/`mailto:a@b` pass; `javascript:…`,
  `data:…`, `vbscript:…`, `file:…`, relative `/x`, protocol-relative `//x`, empty,
  non-string → `undefined` (title/id shown, no link).
- **E8 targets config:** `HUD_ENABLED_TARGETS` unset → all four; `"board, drive"`
  → those two (trim + lowercase + dedupe); `"board,bogus"` → `["board"]`;
  `"bogus"` (all invalid) → all four (fail-open so a typo never bricks dispatch);
  server rejects a disabled target even if a stale client submits it.
- **E9 selected target disabled client-side:** console falls back to first enabled
  (prefer `board`) so the chair never has a disabled target selected.

## 5. Acceptance Criteria

- **AC1:** `dispatchSchema.safeParse({target:'board', question:'x'.repeat(2001)})`
  fails; `2000` succeeds. Route returns 400 for the former (existing 400 path).
- **AC2:** With `maxInflightPerSession()===3` and 3 in-flight dispatches for the
  session, a 4th POST returns **429**; with 2, it returns 201.
- **AC3:** `renderBoardContext` given a column of 100 cards emits ≤ 40 card lines +
  an "omitted" line; given content over `maxChars` returns a string of
  `length ≤ maxChars` ending in the truncation marker.
- **AC4:** When the worker's poll detects the row is `cancelled` and a `jobId` is
  set, `mcp().cancelDispatch(jobId)` is called exactly once and the worker returns
  without marking `done/failed`.
- **AC5:** `POST /api/hud/[id]/end` issues an `updateMany` moving that session's
  `queued|running` dispatches to `cancelled`.
- **AC6:** `sanitizeCitationUrl` — four-shape contract: passes valid http/https/
  mailto; rejects javascript/data/vbscript/file/relative/protocol-relative;
  edge (whitespace-trim, uppercase scheme `HTTPS://`); degraded (`''`, `null`,
  `undefined`, number) → `undefined`. `parseDispatchAnswer` strips a
  `javascript:` citation URL to `undefined`.
- **AC7:** `GET /api/hud/config` returns `{ enabledTargets }` honoring
  `HUD_ENABLED_TARGETS`; `AgentConsole` disables a chip absent from the set.
- **AC8:** Full suite green; `tsc`, `eslint --max-warnings 0`, `build` clean.

## 6. Architecture Decision

- **New pure config module** (`config.ts`) centralizes every new tuning knob and
  target-enablement — one source of truth read by both the route (server
  enforcement) and the config API (client gating). Pure/env-only ⇒ unit-testable.
- **URL sanitizer is pure and co-located** with citation parsing in `dispatch.ts`;
  applied at parse-time (data cleaned before storage) and defensively at render
  (covers any pre-existing rows). Detector-shaped ⇒ four-shape contract tests.
- **Board serialization split** into a pure `renderBoardContext` (capping +
  truncation, unit-tested) and the I/O `buildBoardContext` (bounded prisma fetch).
- **Cancellation is worker-driven** through the existing `DispatchMcpClient` seam,
  so the mocked-client unit test covers it and no new test seam is introduced.
  End-session reuses the same mechanism by marking dispatches `cancelled`.
- **Capability gating is server-authoritative** (route rejects) with the client as
  UX only; delivered via a new additive `GET /api/hud/config` route + an
  `AgentConsole` self-fetch, so the parallel branch's `page.tsx` is untouched.
- **No schema change:** concurrency counts use existing indexes
  (`[hudSessionId,status]`, `[status]`); per-org count tolerates a partial-index
  scan on a low-volume table.
