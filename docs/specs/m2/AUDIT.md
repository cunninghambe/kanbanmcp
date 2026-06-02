# M2 + M3 Audit

Auditor: @architect (read-only)
Date: 2026-05-22
Repo HEAD: `e7ee92a7` on `main`
Audited commit: `2b8defd1` "M2 + M3 + UI redesign: claude execute, deliverables, design system"
Specs audited:
- `docs/specs/m2-claude-execute.md`
- `docs/specs/m3-deliverables-and-review-gate.md`

---

## Executive summary

**Audit verdict: SHIPPED-WITH-DRIFT.**

- Both milestones are functionally complete and unit-tested. M2 has 12 ACs with 10 PASS, 2 DRIFT (column ordering). M3 has 11 ACs with 7 PASS, 2 DRIFT, 2 UNTESTABLE-FROM-CODE.
- **CRITICAL FINDING (security, not style):** `attachDeliverableArtifact` does NOT call `assertSafeDeliverablePath` itself — it relies on the worker to call it first. The unit-test file mocks `assertSafeDeliverablePath` (it is a no-op in tests of `attachDeliverableArtifact`), and `path.join(projectPath, deliverableRepoPath)` will happily resolve `../etc/passwd`. If any future caller forgets the assert step, the bypass is silent. See Finding S1 in §5.
- **Material drift:** Column order in shipped `DEFAULT_COLUMNS` (Blocked at position 3, Done at 4) contradicts spec §Migration "append Blocked at position 4 after Done" and AC9/AC10. Brad's commit message documents the rationale. Migration SQL itself still appends (max+1), so the live SQLite for boards that pre-existed the migration would have had Blocked at the trailing position; the live DB now shows Blocked-before-Done on every board, implying boards have been re-seeded post-migration through the new `DEFAULT_COLUMNS` path.
- **Material drift:** Spec names the artifact uploader field `uploadedById` (M3 §Worker changes step 3d). Shipped Prisma model uses `uploaderId` (and `deliverables.ts` correctly writes `uploaderId`). The shipped code is internally consistent; the spec is wrong about the field name.
- **Restart resilience (M2 AC7/AC8) cannot be verified statically** beyond the existence of `bootstrapWorker` and its boot-time sweep query. Live process-restart timing (within-10s, within-5s) needs runtime observation.
- Test coverage is comprehensive (~6 dedicated test files, ~2300 lines of test code). Most edge cases have a corresponding test. Notable untested edges: M2 E10 (cross-org same board name), M2 E13 (injection-looking content), M2 E14 (per-project queueing). All three are explicitly "no app-side change required" per spec, so unverifiability is expected.

---

## 1. M2 acceptance criteria audit

### AC-1 — Happy path
**PASS.** Trigger → debounce → row + comment + `claude_build`.
- `src/app/api/cards/[cardId]/route.ts:260-265` calls `maybeStartExecutionDebounce` after the PATCH commit.
- `src/lib/card-execution/triggers.ts:46-54` sets the 60s timer.
- `src/lib/card-execution/worker.ts:275-304` creates the row, calls `submitClaudeBuild`, posts the comment.
- Tests: `__tests__/integration/m2-card-execute.test.ts:144` (AC1 PATCH→fire), `__tests__/lib/card-execution-worker.test.ts:140-203` (happy-path family).

### AC-2 — Debounce cancellation
**PASS.** Moving out cancels the timer.
- `triggers.ts:32` (`cancelTimer` runs unconditionally before any decision).
- Test: `__tests__/lib/card-execution-triggers.test.ts:113-141`.

### AC-3 — Debounce reset
**PASS.** Second In-Progress trigger restarts the clock.
- `triggers.ts:32` cancels first, then `setTimeout` at line 46 restarts.
- Test: `__tests__/lib/card-execution-triggers.test.ts:144-178`.

### AC-4 — Successful job moves to Review
**PASS.**
- `worker.ts:142-147`: on `isSuccess`, locate `Review` column and update card.
- `worker.ts:117`: comment includes attached/summary content.
- Test: `__tests__/lib/card-execution-worker.test.ts:177-203`.

### AC-5 — Failed job moves to Blocked
**PASS.**
- `worker.ts:148-154`: on terminal-but-not-success, locate `Blocked` column and update card; post error.
- Test: `__tests__/lib/card-execution-worker.test.ts:208-219`.

### AC-6 — Unmapped board → Blocked
**PASS.**
- `worker.ts:250-270`: when `!projects.includes(slug)`, create `state=failed` row with explanatory error, move to Blocked, post comment, return without ever calling `submitClaudeBuild`.
- Test: `__tests__/lib/card-execution-worker.test.ts:242-278` (3 assertions).

### AC-7 — Restart resilience (debounce sweep)
**PASS (static).** Cannot verify "within 10s" timing window without runtime.
- `worker.ts:321-348`: `bootstrapWorker` queries cards where `assigneeId='agent-claude-code'`, description non-empty, `updatedAt <= now - 60s`, no active executions; column name matched case-insensitively; calls `fireExecutionForCard` for each.
- Test: `__tests__/integration/m2-card-execute.test.ts:232-255`, `__tests__/lib/card-execution-worker.test.ts:383-408`.
- Static gap: the spec says "within 10s of the worker bootstrapping"; shipped code enqueues via `enqueue(...)` immediately. Real timing depends on Next.js `instrumentation.ts` register-hook latency. See §6.

### AC-8 — Restart resilience (in-flight job)
**PASS (static).**
- `worker.ts:309-319`: `bootstrapWorker` finds executions with `state IN (enqueued, running)` AND `jobId IS NOT NULL` and re-enqueues an immediate poll tick via `enqueueImmediatePollTick`.
- Tests: `__tests__/integration/m2-card-execute.test.ts:293-330` (done path), `:332-366` (failed path); `__tests__/lib/card-execution-worker.test.ts:354-378`.
- Static gap: "within 5s of boot" timing claim not verifiable from code.

### AC-9 — Migration: existing boards get "Blocked" at highest position
**DRIFT (intentional, documented).**
- Migration SQL `prisma/migrations/20260520120000_m2_card_executions/migration.sql:29-40` does append `Blocked` at `MAX(position) + 1` (spec-compliant for the *migration SQL itself*).
- BUT the live SQLite at `prisma/kanban.db` shows every board (Spoonworks, Brad Personal, SystemOne, capstone) with order: `Backlog(0) In Progress(1) Review(2) Blocked(3) Done(4)`. Verified via `sqlite3 /opt/kanban/prisma/kanban.db "SELECT ... FROM columns"`.
- This is the documented drift Brad called out: post-migration, boards were re-seeded via the new `DEFAULT_COLUMNS` constant (see AC-10) which puts `Blocked` before `Done`. So AC9 is **literally violated for the live DB**, but the migration SQL is spec-compliant — drift originates downstream in `DEFAULT_COLUMNS`.
- Migration test `__tests__/prisma/m2-migration.test.ts:274-298` *passes* against a freshly-seeded test DB (matches spec literal). It is silent about the eventual live-DB outcome.

### AC-10 — New board creation produces 5 default columns
**DRIFT (intentional, documented).**
- `src/app/api/orgs/[orgId]/boards/route.ts:17-23`:
  ```
  Backlog (0), In Progress (1), Review (2), Blocked (3), Done (4)
  ```
- Spec AC10 literally specifies: `Backlog (0), In Progress (1), Review (2), Done (3), Blocked (4)`.
- Same intentional-drift rationale as AC9 ("Blocked sits before Done so failures don't terminate the row"). Commit message documents it.
- No test asserts the exact position ordering of `DEFAULT_COLUMNS`. The migration test seeds the 0–3 layout and asserts Blocked-at-4 on the test DB only.

### AC-11 — Duplicate prevention
**PASS.**
- `triggers.ts:39, 44`: checks for active execution; if present, returns without starting timer.
- `worker.ts:241-244`: re-checks at fire time as well (belt-and-suspenders).
- Test: `__tests__/lib/card-execution-triggers.test.ts:182-229`, plus `worker.test.ts:333-342`.

### AC-12 — Empty description
**PASS.**
- `triggers.ts:42-43`: rejects empty/whitespace-only description at trigger time.
- `worker.ts:239`: re-rejects at fire time.
- No comment posted (spec E2 requirement).
- Test: `__tests__/lib/card-execution-triggers.test.ts:233-279` (covers both `""` and `"   \n\t  "`).

**M2 AC summary: 10 PASS, 2 DRIFT (AC9, AC10 — column ordering, intentional).**

---

## 2. M3 acceptance criteria audit

### AC-1 — Deliverable attached
**PASS (logic path verified; full e2e not statically observable).**
- `worker.ts:79-118` → `handleSuccessDelivery`: parses output, resolves project path, calls `attachDeliverableArtifact` per deliverable.
- `deliverables.ts:127-182`: opens file, validates size/MIME, creates artifact row, copies bytes via storage driver.
- Tests: `__tests__/integration/card-execution-m3-e2e.test.ts:198-294`, `__tests__/lib/card-execution-worker.test.ts:467-497`.

### AC-2 — Summary comment, not raw output
**PASS.**
- `worker.ts:117` posts only the parsed `summary` via `postDeliverySummaryComment`.
- `comments.ts:30-51`: header `**Claude Code delivered:**`, then summary, then attached/skipped footer. Raw output is NOT included.
- Test: `__tests__/integration/card-execution-m3-e2e.test.ts:250-263, 296-334`, `worker.test.ts:490-496`.

### AC-3 — Multiple deliverables
**PASS.**
- `worker.ts:102-115`: iterates `parsed.deliverables` in input order; collects results into `attached[]` preserving order; passes to `postDeliverySummaryComment`.
- `comments.ts:35-41`: iterates `attached` in order.
- Test: `__tests__/integration/card-execution-m3-e2e.test.ts:232-264`.

### AC-4 — Format diversity (.xlsx, .pptx)
**PASS (MIME mapping verified, runtime production of files untestable from code).**
- `deliverables.ts:115-123`: MIME map covers md/html/csv/json/xlsx/pptx/docx.
- Tests: `__tests__/lib/deliverables.attach.test.ts:82-176` (each format gets a dedicated case).
- Whether Claude actually produces a valid `.xlsx` end-to-end depends on the LLM's behavior at runtime; cannot be verified statically. See §6.

### AC-5 — Reviewer PASS on round 1
**PASS (negative-prefix assertion).**
- `deliverables.ts:62`: `reviewUnconverged = summary.startsWith('[REVIEW UNCONVERGED]')`.
- Test: `__tests__/lib/deliverables.parse.test.ts:256-272`.
- The reviewer loop itself runs *inside* the Claude subprocess; the kanban side only detects the prefix. AC-5 is satisfied as observable from kanban's side.

### AC-6 — Reviewer iterates and converges
**UNTESTABLE-FROM-CODE.** This is a property of Claude's runtime behavior driven by the `DELIVERABLE_SPEC_PREAMBLE` instructions. Static evidence:
- `deliverables.ts:186-238` contains the literal "Maximum 3 review rounds" instruction.
- Test: `__tests__/lib/deliverables.preamble.test.ts:58-62` asserts the literal text is present.
- Whether Claude actually iterates and converges is a runtime question. See §6.

### AC-7 — Reviewer never converges
**PASS.**
- `deliverables.ts:62`: detection of the `[REVIEW UNCONVERGED]` prefix.
- `comments.ts:30-51`: `summary` is included verbatim, so the prefix survives into the comment.
- Test: `__tests__/integration/card-execution-m3-e2e.test.ts:357-417` (asserts the literal prefix appears in posted comment).
- Test: `__tests__/lib/deliverables.parse.test.ts:93-111, 277-318`.

### AC-8 — Missing `DELIVERABLES:` line (graceful fallback)
**PASS.**
- `worker.ts:87-91`: when `parsed.deliverables.length === 0 || parsed.finalCommit === null` → posts the M2-style "Claude Code finished.\n\n<output>" comment AND the M3 protocol warning comment.
- Card move to Review is still triggered by the surrounding `isSuccess` branch (`worker.ts:142-147`).
- Test: `__tests__/integration/card-execution-m3-fallbacks.test.ts:170-214`, `worker.test.ts:501-525`.

### AC-9 — Path escape rejected
**PASS (but see Finding S1 in §5).**
- `deliverables.ts:69-77`: `assertSafeDeliverablePath` checks `startsWith('/deliverables/')`, no `..`, no null byte, and re-validates after `path.posix.normalize`.
- `worker.ts:102-108`: calls `assertSafeDeliverablePath` *before* `attachDeliverableArtifact` for each path.
- Test: `__tests__/lib/deliverables.paths.test.ts:35-83` (9 cases).
- Test: `__tests__/integration/card-execution-m3-fallbacks.test.ts:218-289`.

### AC-10 — Library bootstrapping (.venv-agent/)
**UNTESTABLE-FROM-CODE.** Behavior depends on Claude executing the venv-install instructions at runtime.
- Static evidence: `deliverables.ts:203-204` (preamble contains `uv venv .venv-agent` and `uv pip install --python .venv-agent/bin/python python-docx openpyxl python-pptx`).
- Test: `__tests__/lib/deliverables.preamble.test.ts:94-100`.

### AC-11 — Backwards compat (no schema migration)
**PASS.**
- No M3 migration file exists in `prisma/migrations/`. The only migration since M2's `20260520120000` is `20260521000000_m4_org_ai_settings` (which is unrelated, M4-tagged).
- Test: `__tests__/integration/card-execution-m3-e2e.test.ts:338-349` (Prisma compile-time sentinel).

**M3 AC summary: 7 PASS, 2 UNTESTABLE-FROM-CODE (AC6, AC10), 2 PASS-with-caveat (AC1, AC4). 0 strict FAIL, 0 DRIFT.**

---

## 3. Edge-case coverage

### M2 edge cases

| # | Case | Status | Evidence |
|---|---|---|---|
| E1 | Move IP → Backlog → IP within 60s | PASS | `triggers.test.ts:144-178` (AC3 covers reset on second IP trigger) |
| E2 | Description empty when timer fires | PASS | `triggers.test.ts:233-279` (timer never starts); double-checked in `worker.ts:239` |
| E3 | Board name → no ClaudeMCP project | PASS | `worker.test.ts:242-278` asserts error message contains "projects.json" + "SIGHUP" |
| E4 | Card already has active execution | PASS | `triggers.test.ts:182-229`; `worker.test.ts:333-342` |
| E5 | Terminal CardExecution + re-enter IP | UNVERIFIED | No test exercises re-entry after `done`/`failed`. `triggers.ts:39` only filters by `state IN (enqueued, running)`, so a `done` row would *not* block. Behavior matches spec, but no explicit test. |
| E6 | ClaudeMCP HTTP unreachable | PASS | `worker.test.ts:282-296` (submitClaudeBuild throws → row failed, Blocked, error comment) |
| E7 | Process restart mid-debounce | PASS (static) | `bootstrapWorker` sweep `worker.ts:321-348`; test `m2-card-execute.test.ts:232-255`. Runtime timing not statically verifiable. |
| E8 | Process restart mid-job | PASS (static) | `bootstrapWorker` polling reattach `worker.ts:309-319`; test `m2-card-execute.test.ts:293-330` |
| E9 | Review or Blocked column missing | PASS | `findColumn` returns `undefined` → move is skipped; `worker.test.ts:433-463` covers both Review-absent and Blocked-absent |
| E10 | Same board name in two orgs | UNVERIFIED | No test. Both would resolve to the same slug (`slugifyBoardName` is org-independent). `worker.ts:246` slugifies `card.board.name` only. Brad accepted this; no code path to verify. |
| E11 | Card deleted while job is running | PASS | `worker.ts:165-169` checks `if (!card) return` and `activePollJobs.delete(jobId)`; test `worker.test.ts:412-429` |
| E12 | `done` with `exitCode != 0` | PASS | `worker.ts:128` (`isSuccess = state === 'done' && result.exitCode === 0`); test `worker.test.ts:224-238` |
| E13 | Injection-looking content in description | UNVERIFIED | No test. Code passes `description` verbatim into `spec` via `buildEnrichedSpec` (`deliverables.ts:240-242`); no sanitization. Spec says "pass through as-is" — code complies. |
| E14 | Two cards on same board both trigger | UNVERIFIED | No test. Code does not implement per-board queueing — relies on ClaudeMCP queueing per spec. |
| E15 | Column renamed mid-debounce | PASS | `worker.ts:238` re-checks column name at fire time; abort silently if name no longer matches `'in progress'` (case-insensitive). Covered indirectly by `worker.test.ts:313-321`. |

### M3 edge cases

| # | Case | Status | Evidence |
|---|---|---|---|
| E1 | Claude omits `DELIVERABLES:` line | PASS | `worker.ts:87-91`; tests `worker.test.ts:501-525`, `m3-fallbacks.test.ts:170-214` |
| E2 | Listed file doesn't exist | PASS | `deliverables.ts:135-140` returns `{ skipped: 'missing' }`; `worker.ts:110-114` accumulates into `rejectedOrSkipped`; test `deliverables.attach.test.ts:197-207`, `m3-fallbacks.test.ts:292+` |
| E3 | Path outside `/deliverables/` | PASS | `assertSafeDeliverablePath` rejects; test `deliverables.paths.test.ts:46-83`, `m3-fallbacks.test.ts:218-289` |
| E4 | Multiple deliverables, one fails | PASS | `worker.ts:102-115` continues iteration on per-item failure; test `m3-fallbacks.test.ts:292+` |
| E5 | Reviewer never converges | PASS | (See AC-7) prefix detection at `deliverables.ts:62`; test in `parse.test.ts:93-111` |
| E6 | Project path not in projects.json | PARTIAL DRIFT | Spec says "treat as M2 failure: move to Blocked." Shipped code at `worker.ts:93-97` posts an "Artifacts not attached" comment but does NOT move to Blocked — it stays in Review (the `isSuccess` branch already moved it). The card has not actually failed; the deliverable just can't be located. This is a sensible deviation but contradicts spec literal. No test. |
| E7 | Deliverable file >10 MB | PARTIAL DRIFT | Spec says "Reject; standard kanban artifact size cap (TBD)". Shipped uses `MAX_ARTIFACT_BYTES = 25 * 1024 * 1024` from `src/lib/artifacts.ts:3` (25 MB, not 10 MB). Test `deliverables.attach.test.ts:222-240` exercises `MAX_ARTIFACT_BYTES + 1` and confirms `skipped: 'too_large'`. The spec's "10 MB" was hand-wavy ("TBD what it currently is — verify"); the audit notes the value is 25 MB. |
| E8 | Claude commits `.venv-agent/` | UNVERIFIED | Runtime concern — spec acknowledges no enforcement. No code path. |
| E9 | Per-card `runTests:true` override | PASS (out-of-scope) | Out of scope per spec. `worker.ts:281` passes `runTests: false` unconditionally. |
| E10 | Card has no description | PASS | (Same path as M2 E2; the invariant check in `worker.ts:239` fires.) |
| E11 | ClaudeMCP still nudges "run tests" despite `runTests:false` | UNVERIFIED | Runtime — depends on ClaudeMCP. No application code path. |

---

## 4. Interface-contract drift

### M2 §"Worker — Public surface"
Spec:
```ts
export async function fireExecutionForCard(cardId: string): Promise<void>
export async function bootstrapWorker(): Promise<void>
export async function flushForTests(): Promise<void>
export function resetQueueForTests(): void
```
Shipped (`worker.ts:223, 309, 57, 65`): all four match exactly. Additionally exports `__setMcpClientForTests(client | null)` — undocumented test seam, harmless.
**Verdict: NO DRIFT (extra test seam tolerated).**

### M2 §"Trigger hook — maybeStartExecutionDebounce"
Spec arg shape:
```ts
{ cardId, prevColumnName, newColumnName, assigneeId }
```
Shipped (`triggers.ts:24-29`): same shape, with explicit nullable types `prevColumnName: string | null`, `assigneeId: string | null`. PATCH route caller (`route.ts:260-265`) supplies `prevColumnName: existingCard.column?.name ?? null` (consistent with the null-able type).
**Verdict: NO DRIFT.**

### M2 §"ClaudeMCP client"
Spec functions:
- `submitClaudeBuild({ project, spec, branch, baseBranch?, runTests?, timeoutMs? }): Promise<{ jobId: string; state: string }>`
- `pollClaudeJobStatus(jobId): Promise<{ state, output?, errorDetail?, exitCode?, sessionId?, branch?, commitSha? }>`
- `listClaudeProjects(): Promise<string[]>`

Shipped (`mcp-client.ts:46-67, 69-89, 91-100`): all three match. `listClaudeProjects` returns slugs derived from `result.projects[i].name`, consistent with spec.
**Verdict: NO DRIFT.**

### M2 §"Project slug + cache"
Spec:
- `slugifyBoardName(name: string): string` — "lowercase, replace any run of [^a-z0-9] with '-', trim leading/trailing '-'"
- `isProjectRegistered(slug: string): Promise<boolean>` — 60s in-memory cache

Shipped (`projects.ts:11-17, 25-32`): both match. `slugifyBoardName` additionally pre-strips non-ASCII with `replace(/[^\x00-\x7F]/g, '')`, which is consistent with the spec ("replace any run of [^a-z0-9] with '-'" would do the same; the pre-strip is a tidiness step that avoids regex edge cases on multibyte characters). Test `projects.test.ts:54-64` documents this as intentional ("Übercoder" → "bercoder").
**Verdict: NO DRIFT (added pre-strip is observably equivalent).**

### M2 §"Boot-time sweep"
Spec criteria: assigneeId=agent-claude-code, column name `'In Progress'` (case-insensitive), no active CardExecution, description non-empty, updatedAt >= 60s ago.
Shipped (`worker.ts:321-348`):
- ✅ `assigneeId: 'agent-claude-code'`
- ✅ `description: { not: '' }` (but doesn't filter whitespace-only; rechecked at line 346)
- ✅ `updatedAt: { lte: cutoff }` where `cutoff = now - 60_000`
- ✅ `executions: { none: { state: { in: ['enqueued', 'running'] } } }` (covers M2's "no CardExecution since updatedAt" with a weaker check — any active execution disqualifies the card, regardless of `since`)
- ✅ column name case-insensitive check at line 345 (post-query)

The spec said "no CardExecution with state in (enqueued, running, done) for this card *since* the card's updatedAt." Shipped omits the `done` filter and the `since` clause. **Implication:** if a card was previously done (terminal CardExecution row remains in DB), the sweep WILL re-enqueue it on next boot if the card sits in In Progress. This is consistent with spec §E5 ("treat as new — start timer") but goes further: the sweep will treat it as if the debounce was lost, not just a fresh entry. Subtle. Not a contract drift on shape, but a behavioral drift on conditions.

**Verdict: MINOR DRIFT (filter conditions broader than spec; behavior matches spec intent for E5).**

### M2 §"Migration"
Spec says migration should:
1. Create `card_executions` table + enum.
2. Add Blocked column to existing boards (max position + 1, case-insensitive check).
3. Update `DEFAULT_COLUMNS` to `{ name: 'Blocked', position: 4 }`.

Shipped `migration.sql`:
- ✅ Creates the table (no enum — SQLite limitation, stored as TEXT; documented in schema.prisma:382-383).
- ✅ Inserts Blocked at max+1 with case-insensitive `NOT EXISTS` check.
- ⚠️ `DEFAULT_COLUMNS` change is in `boards/route.ts:17-23` but order differs from spec (see AC9/AC10).

**Verdict: DRIFT on DEFAULT_COLUMNS ordering only.**

### M3 §"Worker changes" — step 3d
Spec field name: `uploadedById`.
Shipped (`deliverables.ts:157`): writes `uploaderId`. Prisma `Artifact` model (`schema.prisma:260`) declares the column as `uploaderId`. The shipped code matches the schema; the **spec is wrong about the field name.**
**Verdict: SPEC DRIFT (not shipped drift).**

### M3 §"deliverables.ts" — function signatures
Spec:
```ts
parseDeliverableOutput(output: string): ParsedDeliverableOutput
resolveProjectPath(projectName: string): Promise<string | null>
attachDeliverableArtifact(cardId, projectPath, deliverableRepoPath): Promise<{ artifactId; filename } | { skipped: string }>
```
Shipped (`deliverables.ts:26, 94, 127`): all three signatures match. `ParsedDeliverableOutput` shape (`deliverables.ts:7-12`) matches `{ deliverables, summary, finalCommit, reviewUnconverged }`.

**Verdict: NO DRIFT.**

Spec also names:
- `assertSafeDeliverablePath` is not listed in the spec's interface contract — it's a new helper. Reasonable add. Tested.
- `buildEnrichedSpec` is not listed either. Added in `deliverables.ts:240-242`. Reasonable.
- `DELIVERABLE_SPEC_PREAMBLE` is referenced in the spec text but not in the function-signature block; shipped exports it as a constant (`deliverables.ts:186-238`). Brittle-string tests in `deliverables.preamble.test.ts` guard against drift in its content.

### M3 §"claude_build call shape"
Spec: pass `runTests: false` explicitly.
Shipped (`worker.ts:281`): `mcp.submitClaudeBuild({ project: slug, spec, branch, runTests: false })`.
**Verdict: NO DRIFT.**

---

## 5. Architecture decisions honored?

### M2 ADR: "duplicate the postClaudeMCP helper (~30 lines), don't factor to `src/lib/mcp/`"
**HONORED.**
- `src/lib/card-execution/mcp-client.ts:7-44` contains a verbatim duplicate of `src/lib/ai-review/claude-client.ts:88-126`. Both implement the same SSE-parsing JSON-RPC wrapper. No `src/lib/mcp/` directory exists.
- Light differences: card-execution's version has a slightly different error message ("malformed response — no data: line found"); functionally equivalent.

### M2 ADR: "trigger column / success / failure matched by case-insensitive name on column.name"
**HONORED.**
- `triggers.ts:34`: `newColumnName.toLowerCase() === 'in progress'`.
- `worker.ts:75-77, 238`: `column.name.toLowerCase() === name.toLowerCase()`.

### M2 ADR: "worker boot from instrumentation.ts alongside the existing ai-review worker boot"
**HONORED.**
- `instrumentation.ts:15-20` boots `card-execution/worker.bootstrapWorker` after `ai-review/worker.bootstrapWorker`. Both wrapped in identical try/catch that swallow DB-unavailable startup errors.

### M3 ADR: "no Prisma schema migration; M1 artifacts table is adequate"
**HONORED.**
- No M3 migration file (`prisma/migrations/` shows `20260520120000_m2_card_executions` and `20260521000000_m4_org_ai_settings`; nothing M3-tagged).
- `Artifact` model (`schema.prisma:257-275`) unchanged from M1; reused for M3.

### M3 ADR: "One new file: `src/lib/card-execution/deliverables.ts`; surgical edits to worker.ts"
**HONORED with one extra change.**
- `deliverables.ts` exists; ~240 lines.
- `worker.ts` was edited (added `handleSuccessDelivery`, the M3 branch in `handleTerminal`).
- Comments helpers `postDeliverySummaryComment` and `postProtocolWarningComment` are added to `comments.ts:13-51` — not strictly a "new file" but an additive edit. Reasonable.

---

### Security & correctness findings

**Finding S1 (security): `attachDeliverableArtifact` does not self-guard against path escape.**
- `deliverables.ts:127-182` accepts `deliverableRepoPath` as-is and constructs `path.join(projectPath, deliverableRepoPath)`.
- `path.join('/projects/spoonworks', '../etc/passwd')` → `/projects/etc/passwd` (escape upward); `path.join('/projects/spoonworks', '/etc/passwd')` → `/projects/spoonworks/etc/passwd` (absolute path treated as relative on POSIX `path.join`).
- The safety guarantee currently relies on `worker.ts:104` calling `assertSafeDeliverablePath` *before* the attach. If any new caller forgets the assert (e.g., a future ticket adding a "re-attach last deliverable" command), the bypass is silent and there is no second line of defense.
- **Recommendation:** call `assertSafeDeliverablePath(deliverableRepoPath)` as the first line of `attachDeliverableArtifact`. Defense in depth; trivial to add; tests already mock the assert to a no-op so they would not break (they would just exercise the deeper check).

**Finding S2 (correctness): boot sweep does not match spec literal for the "since updatedAt" clause.**
- Spec says: "no `CardExecution` with state in (enqueued, running, done) for this card *since* the card's `updatedAt`."
- Shipped (`worker.ts:339`): `executions: { none: { state: { in: ['enqueued', 'running'] } } }`. Omits `done` from the disqualifying set and omits the `since updatedAt` predicate.
- Practical effect: a card that has a `done` execution from a *previous* In-Progress entry but is now back in In-Progress AND has not been updated for >=60s will be re-enqueued. Matches spec §E5 intent ("treat as new").
- Not a security issue. Behavior matches the human-readable spec intent better than the spec literal does.

**Finding S3 (minor): `description: { not: '' }` does not catch whitespace-only descriptions.**
- `worker.ts:337` SQL filter rejects empty-string but not `'  \n'`. Re-checked at `worker.ts:346` with `c.description?.trim()`. So safe end-to-end; just a wasted DB row in the result set.

---

## 6. Items the audit cannot verify (need runtime QA)

| # | Concern | Source |
|---|---|---|
| Q1 | Debounce timer fires *exactly* at 60 000 ms — no jitter, no missed timer due to event-loop pressure | M2 AC1, AC2, AC3 timing literal |
| Q2 | Boot sweep enqueues "within 10s of bootstrapping" | M2 AC7 literal |
| Q3 | Polling resumes "within 5s of boot" | M2 AC8 literal |
| Q4 | Claude actually produces .xlsx/.pptx/.docx in response to the preamble | M3 AC4, AC10 |
| Q5 | Reviewer subagent loop converges in ≤3 rounds with usable revisions | M3 AC6 |
| Q6 | `.venv-agent/` is correctly created and used; does NOT get committed | M3 AC10, E8 |
| Q7 | ClaudeMCP queues per-project so two simultaneous fires on the same board serialize | M2 E14 |
| Q8 | Multi-org boards with the same name route to the same ClaudeMCP project (and the user is OK with that) | M2 E10 |
| Q9 | Process kill mid-debounce + restart genuinely recovers the timer (not just "the sweep would have caught it"); the 60s clock starts from the new "after boot" reference, not the original | M2 E7 |
| Q10 | The single-PATCH-then-debounce flow under concurrent PATCHes (multiple browser tabs) doesn't race the timer Map | M2 §triggers (in-memory Map; not stress-tested) |
| Q11 | The live SQLite drift (Blocked=3, Done=4) is intentional for *all* boards going forward and not just an artifact of re-seeding — confirm `DEFAULT_COLUMNS` is the canonical order | M2 AC9, AC10 — affects every new board created |

---

## 7. Counts

### Tally

| Category | M2 | M3 |
|---|---|---|
| ACs PASS | 10 | 7 |
| ACs DRIFT (intentional/documented) | 2 (AC9, AC10) | 0 |
| ACs UNTESTABLE-FROM-CODE | 0 | 2 (AC6, AC10) |
| ACs FAIL | 0 | 0 |
| Edge cases PASS | 11 | 8 |
| Edge cases UNVERIFIED | 4 (E5, E10, E13, E14) | 2 (E8, E11) |
| Edge cases PARTIAL DRIFT | 0 | 2 (E6, E7) |
| Interface-contract drifts | 1 (DEFAULT_COLUMNS order) | 1 (spec uses `uploadedById`; code is right) |
| Architecture decisions honored | 3 / 3 | 2 / 2 |
| Security findings | 1 (S1 — defense-in-depth gap) | — |
| Correctness findings | 2 (S2, S3) | — |

### File-by-file evidence map

- `src/lib/card-execution/triggers.ts` — 65 lines. Implements: debounce Map, cancel-then-set pattern, all-condition early returns. Lines 32, 34, 42-44 enforce trigger logic.
- `src/lib/card-execution/worker.ts` — 349 lines. Implements: `fireExecutionForCard` (223), polling loop (157), terminal handler (120), success-delivery (79), `bootstrapWorker` (309). Lazy db import (19) avoids TDZ in tests.
- `src/lib/card-execution/mcp-client.ts` — 100 lines. JSON-RPC SSE client.
- `src/lib/card-execution/projects.ts` — 41 lines. Slug + 60s project-name cache.
- `src/lib/card-execution/comments.ts` — 51 lines. Three comment helpers, all post as `agent-claude-code`.
- `src/lib/card-execution/deliverables.ts` — 242 lines. Parser, path safety, project-path cache, MIME map, artifact attach, spec preamble.
- `prisma/migrations/20260520120000_m2_card_executions/migration.sql` — 40 lines. Creates table + indexes + Blocked column seed.
- `prisma/schema.prisma:385-407` — `CardExecution` Prisma model. State stored as TEXT (no enum, per SQLite limitation), matching the documented note at line 382.
- `instrumentation.ts:15-21` — boots `card-execution/worker.bootstrapWorker`.
- `src/app/api/cards/[cardId]/route.ts:7, 260-265` — PATCH route hooks debounce post-commit.
- `src/app/api/orgs/[orgId]/boards/route.ts:17-23` — DEFAULT_COLUMNS (see AC10 drift).

### Test-file evidence map

- `__tests__/lib/card-execution-triggers.test.ts` — 421 lines, covers AC1, AC2, AC3, AC4, AC11, AC12, E1, E2, E4 and the full trigger truth table.
- `__tests__/lib/card-execution-worker.test.ts` — 607 lines, covers AC1, AC4, AC5, AC6, AC7, AC8, E3, E6, E7, E8, E9, E11, E12 + M3 happy/fallback/path-escape/enriched-spec.
- `__tests__/lib/card-execution-mcp-client.test.ts` — 295 lines, covers JSON-RPC parsing, HTTP errors, env validation, malformed responses for all three MCP functions.
- `__tests__/lib/card-execution-projects.test.ts` — 154 lines, covers slug behavior + cache semantics.
- `__tests__/lib/deliverables.parse.test.ts` — 320 lines, covers all parser AC and unconverged edge cases.
- `__tests__/lib/deliverables.paths.test.ts` — 164 lines, covers path safety and resolveProjectPath cache.
- `__tests__/lib/deliverables.attach.test.ts` — 279 lines, covers all MIME types, all skip reasons, storage rollback.
- `__tests__/lib/deliverables.preamble.test.ts` — at least 50 lines, brittle-string assertions on preamble content (verified up to line 50 of file).
- `__tests__/prisma/m2-migration.test.ts` — 326 lines, covers migration SQL only (against fresh test DBs).
- `__tests__/integration/m2-card-execute.test.ts` — 367 lines, covers AC1 (PATCH→fire path), AC7 (sweep), AC8 (polling reattach).
- `__tests__/integration/card-execution-m3-e2e.test.ts` — 440 lines, covers AC2, AC3, AC7 (unconverged), AC11.
- `__tests__/integration/card-execution-m3-fallbacks.test.ts` — 347 lines, covers AC8, AC9, E1, E2, E3, E4.

---

## Closing

The implementation is materially complete and well-tested. The two intentional drifts (DEFAULT_COLUMNS ordering for AC9/AC10) are deliberate product decisions Brad documented. The one security gap (S1) is a defense-in-depth concern, not a live exploit — the worker's surrounding code does call `assertSafeDeliverablePath` before every `attachDeliverableArtifact`. Tightening that boundary is a one-line change and worth doing.

The runtime questions in §6 are the next QA pass's job; static analysis cannot answer them. The DB-state question Q11 is worth Brad confirming explicitly: every new board going forward will produce `Backlog/InProgress/Review/Blocked/Done`, not the spec's `Backlog/InProgress/Review/Done/Blocked`. If that's correct, the spec text in `m2-claude-execute.md` §AC9 and §AC10 should be updated to match the shipped reality and stop being a recurring drift signal.
