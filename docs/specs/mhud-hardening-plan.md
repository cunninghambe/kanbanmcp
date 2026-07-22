# mhud Hardening — Plan & Spec

**Status:** Ready for implementation · **Source:** end-to-end test findings (3 mock meetings, 25/25 checks passed; recommendations below).
**Scope:** production-hardening of the shipped mhud (Host Meeting HUD) feature. No behaviour changes to the trust model (agents propose, humans approve; dispatch is read-only).

Each work item (WI) is independently implementable and owns a **disjoint set of files** so they can be handed to separate agents without conflict. Every WI must keep `next build`, `tsc --noEmit`, and the existing suite green, and add tests for its own behaviour.

Test command: `SESSION_SECRET=test-secret-0123456789abcdef0123 DATABASE_URL=file:./kanban.db npx vitest run <files>`
(The two `__tests__/prisma/*migration*` suites require a `sqlite3` CLI absent from this sandbox — they fail here but pass in CI; ignore them.)

---

## WI-1 — ChangeSet expiry
**Problem:** proposed ChangeSets never expire (MEETINGCOPILOTSPEC §4.5 wants expire-after-N-days). A stale proposal can land on a board that has since changed.
**Files (owns):** `prisma/schema.prisma`, `src/lib/changesets.ts`, `src/app/api/cron/expire-changesets/route.ts` (new), `__tests__/lib/changesets-expiry.test.ts` (new).
**Approach:**
- Schema: add `expiresAt DateTime?` to `ChangeSet`. `createPendingChangeSet` sets `expiresAt = now + CHANGESET_TTL_DAYS` (env `CHANGESET_TTL_DAYS`, default 14). Run `prisma db push` after editing schema (do NOT create a migration file).
- Add `expireStaleChangeSets(prisma, now?)` to `changesets.ts`: sets `status='expired'` for rows where `status IN ('pending','partially_applied')` AND `expiresAt < now`. Returns count. Idempotent.
- `applyChangeSet` must **refuse** to apply an `expired` ChangeSet (return `{ ok:false, reason:'expired' }`); the apply route maps that to HTTP 409.
- New cron route `POST /api/cron/expire-changesets` — bearer auth against `CRON_SECRET`, mirrors `src/app/api/cron/digest/route.ts` exactly; calls `expireStaleChangeSets`, returns `{ expired: n }`.
**Acceptance:**
- A ChangeSet older than TTL flips to `expired` when the cron runs; applying it returns 409.
- A fresh ChangeSet is untouched by the cron and still applies.
- Cron route rejects a missing/wrong bearer with 401.

## WI-2 — Dispatch rate limit + restart re-poll
**Problem (a):** `POST /api/hud/[id]/dispatch` has no rate limit — a chair (or a loop) can flood ClaudeMCP.
**Problem (b):** on restart, `bootstrapWorker` re-enqueues `running` dispatches, and `processDispatch` re-submits a brand-new ClaudeMCP job — orphaning/duplicating the original upstream job.
**Files (owns):** `src/app/api/hud/[id]/dispatch/route.ts`, `src/lib/host-hud/worker.ts`, `__tests__/lib/host-hud-worker.test.ts` (extend).
**Approach:**
- Rate limit: reuse `checkRateLimit` from `src/lib/rate-limit.ts`. Key on `hud-dispatch:${session.userId}` (fall back to hudSessionId). Default 20 dispatches / 60s; over limit → HTTP 429 `apiError`. Skip when `process.env.PLAYWRIGHT_E2E` is set (match the login route's pattern).
- Re-poll: in `processDispatch`, if the loaded dispatch already has a `jobId` and status `running`, **skip submit** and resume polling that existing `jobId` (don't create a new job). Only submit when `jobId` is null. Keep the existing submit path for fresh dispatches.
**Acceptance:**
- 21st dispatch within the window → 429; counter resets after the window.
- A `running` dispatch with an existing `jobId` re-polls that job on re-enqueue (assert `submitDispatch` is NOT called, `pollDispatchStatus` IS) and completes.
- Fresh dispatch still submits then polls.

## WI-3 — Review screen: per-item reject / retarget
**Problem:** the `/api/changesets/[id]/decisions` API already supports `approved|rejected|retargeted`, but the review UI only offers approve + apply. Rejected items should be excludable; retarget needs a target card.
**Files (owns):** `src/app/(app)/hud/[id]/changes/[changeSetId]/page.tsx`.
**Approach:**
- Per item, add **reject** (and un-reject) alongside the existing approve checkbox; rejected items are visually struck and excluded from apply.
- Add **retarget**: a small input to set a new `targetCardId`, POSTed via `/decisions` with `decision:'retargeted', targetCardId`. Keep it minimal but functional.
- Wire a "reject selected" action to `POST /decisions` before/independent of apply; apply continues to send only the approved item ids. Reflect returned decisions in the UI.
**Acceptance:**
- Rejecting an item then applying does not apply that item; the item shows `rejected`.
- Retargeting posts the new targetCardId and the item reflects `retargeted`.
- Build + lint clean; no API/route changes.

## WI-4 — Metrics endpoint (§7 instrumentation)
**Problem:** none of the spec §7 quality metrics are surfaced.
**Files (owns):** `src/app/api/hud/metrics/route.ts` (new), `__tests__/api/hud-metrics.test.ts` (new).
**Approach:**
- `GET /api/hud/metrics` (human session; `requireSession` + `requireOrgRole` MEMBER; org-scoped) returns JSON:
  - `dispatch`: total, byStatus{done,failed,cancelled,running,queued}, medianLatencyMs (finishedAt−startedAt over done).
  - `changeset`: proposed, applied, expired; `retargetRate` and `rejectRate` over decided ChangeItems; `medianTimeToReviewMs` (ChangeSet.createdAt→appliedAt over applied).
- Pure reads (AgentDispatch, ChangeSet, ChangeItem). No writes.
**Acceptance:**
- Returns correct counts/rates for a seeded fixture; API-key auth allowed as read (org-scoped) but 401 for anonymous.
- Handles empty data (rates → 0, medians → null) without dividing by zero.

## WI-5 — Docs: ClaudeMCP dispatch-agent contract (owner: orchestrator)
**Problem:** Drive/Email/Slack answers depend entirely on the external ClaudeMCP project's tool config; undocumented, so those targets silently fail in prod.
**Files (owns):** `docs/mhud-dispatch-agent-setup.md` (new), `.env.example` (append note only).
**Approach:** document the required ClaudeMCP project setup — the read-scoped mhud ApiKey (`["read","propose"]`), which MCP tools the project needs per target (board→mhud `/api/mcp`, drive→Drive MCP, email→Gmail MCP, slack→Slack MCP), and the env wiring (`CLAUDEMCP_URL`, `HUD_DISPATCH_PROJECT`). Note the `DATABASE_URL` `file:` path resolves relative to the `prisma/` schema dir.

## Deferred (tracked, not in this pass)
- Configurable "stalled" threshold + terminal-column names per board/series (currently hardcoded in `pertinent`), to land with the Meeting/Series models.
