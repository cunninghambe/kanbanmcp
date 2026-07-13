# HUD Meeting Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Host Meeting HUD a functional meeting manager: chair-captured agenda/notes/decisions/action items with one-click card creation, an end-of-session digest, a closed ChangeSet loop (reject/expiry/global page/readable ops), and a richer pertinent rail.

**Architecture:** Additive changes on the existing HUD substrate (see `docs/specs/2026-07-13-hud-meeting-manager.md` — the spec is the source of truth for every contract; this plan sequences the work). One new Prisma model (`HudEntry`), two new pure libs (`capture.ts`, `digest.ts`, plus `changesets-display.ts`), five new routes, three new pages/components, extensions to four existing files. No LLM calls, no new dependencies, nothing security-related (that lives on `fix/hud-hardening` — do not touch those concerns here).

**Tech Stack:** Next 16 App Router, Prisma + SQLite (`prisma db push` — NEVER `migrate deploy`, this DB has no migration baseline), zod, SWR, vitest.

**Workspace:** `/root/kanban-hud` (git worktree, branch `feat/hud-meeting-manager`). Baseline verified: 1033 tests green. The live app in `/opt/kanban` must never be touched.

**Verification gate (every task, before its final commit):**
```bash
npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build
```
All four must pass clean. Commit after each task with the message given in the task.

**Conventions to mirror (read these before coding):**
- Route auth/shape: `src/app/api/hud/[id]/dispatch/route.ts` (requireSession → isApiKeyAuth gate on mutations → requireOrgRole → org-scoped findFirst → zod → work → catch NextResponse).
- API tests: `__tests__/api/` — find the existing HUD/changeset API tests and copy their harness/setup pattern exactly.
- Pure-lib tests: `__tests__/lib/host-hud-dispatch.test.ts`.
- UI: `km-*` classes + `hud.module.css`; component tests: `__tests__/components/hud-session-page.test.tsx`.
- Card creation internals: `case 'create_card'` in `src/lib/changesets.ts:141`.

---

### Task 1: HudEntry schema + capture parser + entries API

**Files:**
- Modify: `prisma/schema.prisma` (add `HudEntry` after `AgentDispatch`; add `entries HudEntry[]` to `HudSession`)
- Create: `src/lib/host-hud/capture.ts`
- Create: `src/app/api/hud/[id]/entries/route.ts` (GET, POST)
- Create: `src/app/api/hud/entries/[entryId]/route.ts` (PATCH, DELETE)
- Create: `src/app/api/hud/entries/[entryId]/card/route.ts` (POST)
- Test: `__tests__/lib/host-hud-capture.test.ts`
- Test: `__tests__/api/hud-entries.test.ts`

- [ ] **Step 1: Schema.** Add the `HudEntry` model exactly as spec §3.1 (comment style matches neighboring models). Run `npx prisma db push && npx prisma generate`. Expected: `The database is now in sync`.
- [ ] **Step 2: Failing parser tests.** Write `__tests__/lib/host-hud-capture.test.ts` covering the four-shape contract with `now = new Date('2026-07-13T10:00:00')` (a Monday):

| # | shape | input | expected |
|---|-------|-------|----------|
| 1 | positive | `"@brad send contract due:fri"` | `{ text: 'send contract', assigneeQuery: 'brad', dueDate: 2026-07-17 }` |
| 2 | positive | `"due:2026-08-01 ship the deck"` | text `'ship the deck'`, dueDate Aug 1, assignee null |
| 3 | positive | `"due:tomorrow @Nadia review"` | text `'review'`, `'Nadia'`, 2026-07-14 |
| 4 | negative (FP boundary) | `"email brad@a1.dev about budget"` | mid-word `@` NOT a mention; text unchanged |
| 5 | negative | `"the deadline is due:someday"` | unrecognized due form stays in text, dueDate null |
| 6 | negative | `"costs @ 5 dollars"` | bare `@` not a token |
| 7 | edge | `"due:2026-13-45 fix dates"` | invalid calendar date stays in text |
| 8 | edge | `"due:mon standup"` with now=Monday | dueDate = NEXT Monday (2026-07-20), not today |
| 9 | edge | `"@brad @nadia pair on this"` | assignee `'brad'`; `@nadia` remains in text |
| 10 | edge | `"due:fri due:mon call"` | first wins (2026-07-17); `due:mon` stays in text |
| 11 | degradation | `""` and `"   "` | `{ text: '', assigneeQuery: null, dueDate: null }` |
| 12 | degradation | `"@brad due:fri"` (tokens only) | text `''` — caller decides rejection |
| 13 | degradation | `"  @brad   send    it  "` | whitespace collapsed: `'send it'` |

  Run `npx vitest run __tests__/lib/host-hud-capture.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement `parseCapture`** per spec §3.2 (pure, `(raw: string, now: Date)`, case-insensitive `due:` forms, weekday = strictly-next occurrence, local-midnight dates). Run the file's tests — expect PASS.
- [ ] **Step 4: Commit** `feat: HudEntry model + deterministic capture parser`
- [ ] **Step 5: Failing API tests.** `__tests__/api/hud-entries.test.ts`, harness copied from the existing HUD API tests. Cases:
  - POST action entry with `"@<seeded member name> pay invoice due:2026-08-01"` → 201, residual text, resolved assigneeId, `assigneeResolution: 'resolved'`.
  - POST with API-key auth → 403 (all three mutating routes).
  - POST on ended session → 409; PATCH `{ checked: true }` on agenda entry of ended session → 200.
  - POST note stores text verbatim (`"@brad due:fri"` stays literal — no parsing for non-action kinds).
  - Ambiguous assignee (seed two members sharing a prefix) → saved unassigned, `'ambiguous'` + candidates ≤ 5.
  - PATCH text/position/assigneeId; DELETE; both 404 on other-org entry (org scoping).
  - Convert: happy path (card lands in leftmost column, title/assignee/dueDate carried, entry.cardId set, done in one transaction); second convert → 409; kind ≠ action → 400; session without board → 409; columnId from another board → 400; >200-char text → truncated title, full text in description.
  - GET returns entries ordered `(kind, position, createdAt)`.
  Run — expect FAIL (routes missing).
- [ ] **Step 6: Implement the three route files** per spec §3.3 (zod schemas verbatim from spec; assignee prefix-match against org members; convert mirrors `create_card` in `src/lib/changesets.ts:141`; `logActivity(..., 'capture_action_card', ...)` fire-and-forget). Run the API tests — expect PASS.
- [ ] **Step 7: Full verification gate, then commit** `feat: HUD entry routes — agenda/notes/decisions/actions + action→card`

### Task 2: ChangeSet expiry, reject recompute, display strings

**Files:**
- Modify: `src/lib/changesets.ts` (add `changeSetTtlDays`, `expireStaleChangeSets`)
- Create: `src/lib/changesets-display.ts`
- Modify: `src/app/api/changesets/route.ts` (expire sweep; `hudSessionTitle` in rows)
- Modify: `src/app/api/changesets/[id]/route.ts` (expire sweep; `display` per item)
- Modify: `src/app/api/changesets/[id]/decisions/route.ts` (all-rejected → set status `rejected`)
- Test: `__tests__/lib/changesets-display.test.ts`; extend the existing changeset API tests

- [ ] **Step 1: Failing tests** for `expireStaleChangeSets` (15-day-old pending → expired + counted; 15-day-old `partially_applied` → untouched; fresh pending → untouched; TTL env override respected, garbage env → default 14) and for `describeChangeItems` (each of the four op formats from spec §3.4 EXACTLY; deleted card → `«id» (not found)`; malformed payload JSON → `«op» (unreadable payload)`; assert one batched query strategy — no per-item card lookups — by counting prisma calls with a spy). Run — FAIL.
- [ ] **Step 2: Implement** both helpers per spec §3.4. Run — PASS.
- [ ] **Step 3: Commit** `feat: changeset lazy expiry + human-readable op descriptions`
- [ ] **Step 4: Failing route tests:** GET list flips stale pending to expired and includes `hudSessionTitle`; GET detail includes `display` on every item; decisions with every item rejected flips set status to `rejected`, subset-rejection leaves `pending`; apply on an expired set errors (existing status guard — assert it).
- [ ] **Step 5: Wire the three routes.** Run — PASS.
- [ ] **Step 6: Full gate, commit** `feat: changeset routes — expiry sweep, reject status, display strings`

### Task 3: Digest lib + route

**Files:**
- Create: `src/lib/host-hud/digest.ts`
- Create: `src/app/api/hud/[id]/digest/route.ts`
- Test: `__tests__/lib/host-hud-digest.test.ts`; extend `__tests__/api/hud-entries.test.ts` or new `__tests__/api/hud-digest.test.ts`

- [ ] **Step 1: Failing `buildDigest` tests:** stats math over a fixture (2 decisions, 1/2 agenda checked, 1 action with card + 1 without, 3 dispatches: done/done/failed, 2 changesets: pending/applied → assert every stats field); markdown contains `## Agenda (1/2)` and an `- [ ]` action line with assignee/due/card; empty-section omission (no notes → no `## Notes`); live session → `durationMs: null`, `(live)` in markdown; answerExcerpt truncation at 200 chars.
- [ ] **Step 2: Implement** `buildDigest` per spec §3.5 (pure; template exact). Run — PASS. Commit `feat: pure digest builder`.
- [ ] **Step 3: Route:** failing test (org member GET on live and ended sessions → 200 `{ digest }`; other-org id → 404), then implement (fetch session + entries + dispatches + changesets + member names, delegate to `buildDigest`). PASS.
- [ ] **Step 4: Full gate, commit** `feat: GET /api/hud/[id]/digest`

### Task 4: MeetingPanel UI

**Files:**
- Create: `src/app/(app)/hud/_components/MeetingPanel.tsx`
- Modify: `src/app/(app)/hud/[id]/page.tsx` (third grid zone; entries SWR at 10s: `/api/hud/${id}/entries`)
- Modify: `src/app/(app)/hud/hud.module.css` (grid: `minmax(280px, 340px)` right column; stack < 1100px)
- Test: `__tests__/components/hud-meeting-panel.test.tsx`

- [ ] **Step 1: Failing component tests** (pattern: `hud-session-page.test.tsx`): agenda renders with checkboxes and check-off PATCHes `{ checked }`; capture input POSTs `{ kind, text }` on Enter and clears; kind chips switch; ambiguous response renders candidates hint; action rows show `→ card` only when `boardId && !cardId`, card link when set; convert button POSTs to `/card` and calls `onMutate`; `live: false` disables add/edit but keeps agenda check-off + convert enabled.
- [ ] **Step 2: Implement** per spec §3.6 — sections agenda / capture / log, `km-*` styling, labeled controls (aria-labels on icon buttons), Enter submits. PASS.
- [ ] **Step 3: Wire into the session page + CSS grid.** Verify the page test still passes; update it for the new zone.
- [ ] **Step 4: Full gate, commit** `feat: HUD meeting panel — agenda, capture, entry log`

### Task 5: Wrap-up view

**Files:**
- Create: `src/app/(app)/hud/_components/WrapUp.tsx`
- Modify: `src/app/(app)/hud/[id]/page.tsx` (ended → WrapUp replaces console+fleet; inline end-confirm in header)
- Test: extend `__tests__/components/hud-session-page.test.tsx` + new `__tests__/components/hud-wrapup.test.tsx`

- [ ] **Step 1: Failing tests:** ended session renders WrapUp (no AgentConsole); stats row from digest; pending proposals link to `/changes/[changeSetId]`; `copy digest` writes `digest.markdown` to a mocked `navigator.clipboard.writeText` and flashes `copied ✓`; header end button requires the two-step confirm before POSTing `/end`.
- [ ] **Step 2: Implement** per spec §3.6 (WrapUp fetches `/api/hud/[id]/digest` + `/api/changesets?hudSessionId=`; MeetingPanel remains mounted for post-meeting conversions). PASS.
- [ ] **Step 3: Full gate, commit** `feat: HUD wrap-up — digest view, proposal handoff, confirm-end`

### Task 6: /changes pages + review relocation + reject UI

**Files:**
- Create: `src/components/changes/ChangeSetReview.tsx` (move component body from the old page)
- Create: `src/app/(app)/changes/page.tsx`
- Create: `src/app/(app)/changes/[changeSetId]/page.tsx`
- Delete: `src/app/(app)/hud/[id]/changes/[changeSetId]/page.tsx`
- Modify: `src/app/(app)/hud/_components/DispatchCard.tsx` (link → `/changes/${id}`)
- Modify: `src/app/(app)/hud/_components/SituationRail.tsx` (proposals stat → `Link` to `/changes`)
- Modify: `src/components/design/Sidebar.tsx` (`Changes` item, GitPullRequestArrow, between HUD and Helpdesk)
- Test: `__tests__/components/changeset-review.test.tsx`, `__tests__/components/changes-page.test.tsx`

- [ ] **Step 1: Failing tests:** review shows `display` sentence prominently with raw JSON inside collapsed `<details>`; `reject selected` POSTs decisions `rejected` and revalidates; `expired` chip renders neutral; apply flow unchanged (existing behavior preserved); list page defaults to `status=pending`, filter chips re-fetch, rows link to `/changes/[id]` and origin HUD; DispatchCard + SituationRail point at the new paths.
- [ ] **Step 2: Implement** (component move is a cut-paste + extend, keep `back to hud` behavior via optional `backHref` prop defaulting to `/changes`). PASS.
- [ ] **Step 3: Grep for the deleted route path** (`/hud/.*/changes/`) across `src/` and `__tests__/` — zero references must remain. Full gate, commit `feat: global /changes pages, reject UI, review relocation`

### Task 7: Pertinent rail upgrades + board deep-link

**Files:**
- Modify: `src/lib/card-movement.ts` (add `listMovementsSince` per spec §3.6)
- Modify: `src/app/api/hud/[id]/pertinent/route.ts` (`dueSoon`, `movedThisSession`, counts)
- Modify: `src/app/(app)/hud/_components/SituationRail.tsx` (two new groups; all card rows → `/board/${boardId}?card=${id}`)
- Modify: `src/app/(app)/board/[boardId]/page.tsx` (`?card=` → `setSelectedCardId`; clear on close via `router.replace`)
- Test: extend the pertinent/card-movement/situation-rail tests; new board deep-link test

- [ ] **Step 1: Failing tests:** `listMovementsSince` returns structured rows newest-first since a timestamp, org-scoped, cap respected; pertinent includes `dueSoon` (in-window, non-terminal, non-overdue, sorted, cap 8) and `movedThisSession` (since `session.startedAt`); rail renders both groups and card-deep-link hrefs; board page opens the modal for a valid `?card=` and ignores unknown ids; close clears the param.
- [ ] **Step 2: Implement.** PASS.
- [ ] **Step 3: Full gate, commit** `feat: pertinent due-soon + session movements, card deep-links`

---

## Self-review checklist (ran at plan time)

- Spec coverage: §3.1→T1, §3.2→T1, §3.3→T1, §3.4→T2, §3.5→T3, §3.6 UI→T4/T5/T6/T7, edge cases distributed into the named test cases, acceptance criteria 1–2→T1, 3→T3, 4→T5, 5–7→T2/T6, 8→T7, 9→every task's gate.
- No placeholders: every step names concrete cases/behavior; contracts live in the spec sections cited inline.
- Type consistency: `parseCapture(raw, now)`, `expireStaleChangeSets(db, orgId, now)`, `describeChangeItems(db, items)`, `buildDigest(input)`, `listMovementsSince(db, { boardId, orgId, since })` — names match spec §3 throughout.
