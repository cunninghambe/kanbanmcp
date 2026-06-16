# Addendum: Host Meeting HUD (live in-meeting copilot)

**Status:** Design draft v0.1 · **Relation:** extends `MEETINGCOPILOTSPEC.md`
**Reverses non-goal §2:** "Real-time in-meeting features" — this addendum adds exactly that, while preserving every trust invariant (no live board mutation; agents propose, humans approve; evidence/provenance on everything).

---

## 0. Recon — does the spec's assumed substrate actually exist?

Verified against the repo at branch `claude/meeting-copilot-hud-x4o2zr`. Real paths and the truth of each claim:

| Spec assumption | Reality | Path |
|---|---|---|
| Prisma schema, org-scoped, cuid, `@@map` snake_case, SQLite | ✅ exact | `prisma/schema.prisma` |
| `Card` / `Board` / `Column` models | ✅ | `prisma/schema.prisma:95-198` |
| `Artifact` model (+ storage driver) | ✅ (cardId-only; **no `meetingId`** yet) | `prisma/schema.prisma:256-279` |
| `AgentActivity` (provenance log) | ✅ `logActivity()` fire-and-forget | `prisma/schema.prisma:227-239`, `src/lib/agent-activity.ts` |
| `Webhook` (outbound) | ✅ `dispatchWebhook()` | `prisma/schema.prisma:241-252`, `src/lib/webhook.ts` |
| `ApiKey` (+ permissions) | ✅ — **but `permissions[]` is parsed and never enforced per-tool** | `prisma/schema.prisma:213-225`, `src/lib/agent-auth.ts:46-62` |
| `OrgAiSettings` (per-org Anthropic key) | ✅ encrypted key, lastFour | `prisma/schema.prisma:52-62` |
| `lib/ai-review` worker: queue + retry + row-status | ✅ see nuance below | `src/lib/ai-review/{worker,queue,claude-client,inheritance,extractors}.ts` |
| `mcp-server.ts` tool registration + `create_card`/`move_card` | ✅ | `src/lib/mcp-server.ts` (`MCP_TOOLS`, `TOOL_HANDLERS`, `handleMcpRequest`; `toolCreateCard:350`, `toolMoveCard:509`) |
| `requireSession` / `requireOrgRole` / `apiError` | ✅ | `src/lib/api-helpers.ts` |
| iron-session vs API-key auth | ✅ `requireSession` accepts **either**; `session.isApiKeyAuth` distinguishes | `src/lib/session.ts`, `src/lib/agent-auth.ts` |
| Cron/digest bearer pattern | ✅ `Authorization === Bearer ${CRON_SECRET}` | `src/app/api/cron/digest/route.ts:41-47` |
| Anthropic SDK setup | ✅ `@anthropic-ai/sdk@0.95.1`; auth precedence org-key → OAuth → env | `src/lib/ai-review/claude-client.ts` |
| Artifact storage driver (local/S3) | ✅ local FS driver; **S3 is a stub** (`throw 'not implemented'`) | `src/lib/storage.ts` |
| Real-time / "collaboration" transport | **SSE over HTTP polling — NOT WebSocket** | `src/app/api/realtime/route.ts`, `src/hooks/useRealtime.ts` |

### Substrate the spec invents that does **not** exist yet
`MeetingSeries`, `SeriesParticipant`, `Meeting`, `Commitment`, `ChangeSet`, `ChangeItem`, `PrepBrief`, and `Artifact.meetingId` are **not in the schema**. The whole Meeting Copilot pipeline (`src/lib/meeting-copilot/`) is greenfield. The HUD must therefore either (a) ship standalone against board state, or (b) depend on the spec's M1 ChangeSet substrate being built first. See §5 decisions.

### Nuances worth knowing before building
1. **Worker queue ≠ retry location.** The "in-process queue" is a single-concurrency **promise chain** (`queueTail = queueTail.then(...)`) with an `inFlightIds` set and `withKeyedLock` dedup; status lives on the row (`pending|running|done|failed|skipped`); `bootstrapWorker()` re-enqueues on boot (`instrumentation.ts`). The **3-retry exponential backoff is NOT in the queue** — it lives in `claude-client.ts` (`RETRY_DELAYS=[1000,4000,16000]`, `MAX_ATTEMPTS=3`) around the Anthropic call. Reuse both, but know they're separate layers.
2. **There are already two background-agent workers**, both on this pattern: `ai-review` (Anthropic calls) and `card-execution` (dispatches/poll an **external "ClaudeMCP" build server** via `src/lib/card-execution/mcp-client.ts` → `submitClaudeBuild`/`pollClaudeJobStatus`/`listClaudeProjects`). **This `card-execution` worker is the closest thing the repo has to "agent-teams" / dispatchable background agents** — there is no model or concept literally named "agent team" (only `Team`/`TeamMember`, which are org groupings). The HUD's dispatch engine should be modeled on `card-execution`.
3. **MCP auth is API-key-only, write tools are NOT permission-gated.** `requireApiKey` parses `permissions[]` into `AgentContext`, but no handler in `mcp-server.ts` checks it — so the spec's §6.2 "service key scoped to proposal + read only" is **aspirational, not implemented**. Building the read-only guarantee means closing this gap.
4. **Reality of the four dispatch targets the request asks for:**
   - **Projects/boards** ✅ — internal Prisma + read MCP tools (`list_boards`, `get_board`, `list_card_tree`, `list_commitments` once it exists).
   - **Google Drive** ✅ — per-user OAuth, **read-only scopes** (`drive.readonly`, `documents.readonly`, `spreadsheets.readonly`, `presentations.readonly`), helpers in `src/lib/google/{drive,docs,sheets,slides}.ts` (`getFileMeta`, `listFolderRecursive`, `parseDriveUrl`). Token in `GoogleCredential` (refresh token encrypted).
   - **Email** ⚠️ — `src/lib/email/` is **outbound send only** (`log`/`resend` providers). There is **no inbox read and no Gmail OAuth scope**. (The spec itself defers Gmail evidence to M3.) Querying email has **no substrate today**.
   - **Slack** ❌ — **no Slack code anywhere** in the repo (no client, no OAuth, no model).
   - *(Note: this Claude session is wired to Gmail/Drive/Calendar/Notion MCP tools, but those are the **operator's** tools, not the running app's — they are not runtime substrate.)*

---

## 1. What the Host Meeting HUD is

A live, glanceable heads-up display for the meeting **chair**, open during the meeting, with two halves:

- **Pertinent panel (read, ambient):** what matters right now for this meeting — open/aging commitments, overdue & stalled cards on the series' board, the suggested agenda, and answers streaming back from dispatched agents. Updates push in real time; the chair glances, doesn't operate.
- **Agent console (dispatch, async):** the chair types a question and picks a target (Board · Drive · Email · Slack), fires it, and **stays present** while a background agent fetches the answer asynchronously and drops it into the HUD with citations. Multiple in flight at once.

**Hard invariant (inherited + extended):** a dispatched agent is **read-only / answer-only**. It can never mutate the board. Anything it *suggests* changing is emitted as a **ChangeSet proposal** (the spec's existing path) that surfaces in *Pending Changes* for **post-meeting, human** approval — never applied live, not even high-confidence.

---

## 2. How it reuses existing infrastructure

| Need | Reused mechanism | Path |
|---|---|---|
| Push pertinent context + answers live | **SSE-over-polling** transport, copied verbatim | `src/app/api/realtime/route.ts` pattern → new `GET /api/hud/[id]/events` |
| Client subscription | `EventSource` + `swr` `mutate` | `src/hooks/useRealtime.ts` pattern → new `useHudStream` |
| Background agent dispatch + poll + status-on-row + boot re-enqueue | **`card-execution` promise-chain worker** | `src/lib/card-execution/worker.ts` pattern → new `src/lib/host-hud/worker.ts` |
| LLM to phrase/summarize answers | Anthropic SDK + org-key precedence | `getAnthropicAuth()` in `src/lib/ai-review/claude-client.ts` |
| Retry/backoff on the LLM call | `RETRY_DELAYS`/`MAX_ATTEMPTS` | same file |
| Drive reads | read-only Google helpers | `src/lib/google/*` |
| Provenance for every dispatch + applied change | `logActivity()` + `AgentActivity` | `src/lib/agent-activity.ts` |
| Human-only gates | `session.isApiKeyAuth` rejection | `src/lib/api-helpers.ts` |
| Read-only agent identity | a scoped `ApiKey` + **newly-enforced** `permissions[]` | `src/lib/agent-auth.ts` + `mcp-server.ts` |

---

## 3. Schema additions (additive, SQLite-safe, convention-matching)

Two new models. Both nullable-FK to the spec's Meeting models so the HUD can ship **before or after** the Meeting Copilot pipeline.

```prisma
model HudSession {
  id        String   @id @default(cuid())
  orgId     String
  chairId   String                 // the present human
  // Soft links — all nullable so HUD is standalone-capable:
  boardId   String?                // board in focus (pertinent panel source)
  seriesId  String?                // MeetingSeries, once that model exists
  meetingId String?                // Meeting, once that model exists
  title     String
  // values: live | ended
  status    String   @default("live")
  startedAt DateTime @default(now())
  endedAt   DateTime?

  dispatches AgentDispatch[]

  @@index([orgId, status])
  @@map("hud_sessions")
}

model AgentDispatch {
  id           String   @id @default(cuid())
  orgId        String
  hudSessionId String
  chairId      String                       // requester (audit)
  // values: board | drive | email | slack
  target       String
  question     String
  // values: queued | running | done | failed | cancelled
  status       String   @default("queued")
  answer       String?                       // rendered markdown
  // JSON: [{ kind, id, title, url?, quote? }] — evidence the answer rests on
  citations    String?
  confidence   Float?
  // When the agent suggests a board change, it lands here (never applied live):
  proposedChangeSetId String?
  jobId        String?                       // external ClaudeMCP job, if used
  error        String?
  createdAt    DateTime @default(now())
  startedAt    DateTime?
  finishedAt   DateTime?

  hudSession HudSession @relation(fields: [hudSessionId], references: [id], onDelete: Cascade)

  @@index([hudSessionId, status])
  @@map("agent_dispatches")
}
```

No changes to `Card`/`Board`/etc. `AgentDispatch.answer`/`citations` are display-only; nothing here can write to the board.

---

## 4. API surface (App Router; existing helpers)

```
POST   /api/hud                         start a session            (human session ONLY)
GET    /api/hud/[id]                     session + dispatches
POST   /api/hud/[id]/end                 mark ended                 (human session ONLY)
GET    /api/hud/[id]/events              SSE stream (pertinent + dispatch updates)
POST   /api/hud/[id]/dispatch            fire an agent query        (human session ONLY)
GET    /api/hud/dispatch/[did]           one dispatch (poll fallback)
POST   /api/hud/dispatch/[did]/cancel    cancel in-flight           (human session ONLY)
```

Every mutating/creating route rejects `session.isApiKeyAuth` (chair must be a present human, consistent with the spec's approve-gate philosophy). The SSE stream reuses the `requireSession` → board/org-scope check from `realtime/route.ts`.

**SSE events:** `hud_context` (pertinent panel changed), `dispatch_updated` (status/answer changed), `dispatch_done`. Client revalidates via `swr` `mutate` exactly like `useRealtime`.

---

## 5. Dispatch engine + the read-only guarantee

`src/lib/host-hud/worker.ts` — a third promise-chain worker (`queueTail`, `inFlightIds`, `bootstrapWorker()` re-enqueue on boot via `instrumentation.ts`). Each `AgentDispatch` row is processed by a target-specific **reader**, then the Anthropic SDK phrases a cited answer:

- `board` → Prisma SELECTs (boards/cards/commitments) → summarize.
- `drive` → `src/lib/google/*` read helpers (chair's `GoogleCredential`) → summarize.
- `email` / `slack` → **no substrate (§0.4)** — see decision below.

**Three layers keep it answer-only:**
1. **No write code path** exists in the worker — it imports only readers.
2. If/when a dispatch is routed through MCP/ClaudeMCP, it authenticates with a **dedicated read-scoped `ApiKey`**, and we **finally enforce `permissions[]` in `mcp-server.ts`** (gate `create_card`/`move_card`/`update_card`/… on a `write` permission; allow only read + `propose_changeset`). This realizes spec §6.2.
3. Suggested changes never apply — they become a **pending `ChangeSet`** (spec §4.4/§4.5), shown in *Pending Changes* for post-meeting human approval. The HUD only ever *links* to that proposal.

Every dispatch and every resulting proposal writes `AgentActivity` (`resourceType: 'agent_dispatch'`) for provenance.

---

## 6. UI

Route `/(app)/hud/[id]` (or launched from a board/series). Components under `src/components/hud/`, following `components/board/` + `components/design/` conventions. Layout is large-type, low-interaction:

- **Pertinent** (left, ambient): open commitments / aging, overdue + stalled cards, suggested agenda. Source = ledger if Meeting models exist, else derived from board state.
- **Agent console** (right): question box + target chips; fired queries appear as answer cards that fill in live (spinner → cited answer). "Ask again", copy, and "open suggested change" affordances.
- **Suggestions** (footer strip): count + link to *Pending Changes*; never an apply button.

---

## 7. Open decisions (need confirmation before build)

1. **Dispatch targets for first cut.** Board + Drive have substrate; Email + Slack do not. Recommend **Board + Drive only**, with Email/Slack shown as disabled "coming soon" chips. Building real Gmail read (new `gmail.readonly` scope + adapter) and Slack (new OAuth app + client lib) is a separate, larger effort.
2. **ChangeSet dependency.** The "suggestion → approval" path wants the spec's `ChangeSet`/`ChangeItem` models, which don't exist. Options: (a) build the **minimal ChangeSet substrate** now so suggestions have a real home; (b) HUD-only first, emitting suggestions as **card comments** until ChangeSet lands. Recommend (a) if we want the trust story intact; (b) if we want the HUD demoable fastest.
3. **Answer engine.** Recommend **in-process Anthropic SDK** direct calls (self-contained, reuses `getAnthropicAuth`) over routing through the external ClaudeMCP build server (which is build-oriented and adds an external dependency).
4. **MCP permission enforcement.** Recommend closing the `permissions[]`-not-enforced gap now (small, also hardens the existing surface) so the read-only agent key is real rather than honor-system.

---

## 8. Build plan (phased)

**H0 — schema + scaffolding.** Add `HudSession` + `AgentDispatch` to `schema.prisma`; `prisma db push`; new module `src/lib/host-hud/`. Tests: model round-trip.

**H1 — dispatch engine (Board target).** Promise-chain worker mirroring `card-execution`; `board` reader (Prisma) + Anthropic summarizer with citations; status-on-row; `bootstrapWorker()` wired into `instrumentation.ts`. REST: `POST /api/hud`, `POST /api/hud/[id]/dispatch`, `GET /api/hud/dispatch/[did]`. All human-only. `AgentActivity` provenance. Tests: enqueue→done, read-only (no write import reachable), human-only rejection of API-key auth.

**H2 — real-time HUD.** `GET /api/hud/[id]/events` SSE (copy `realtime/route.ts`); `useHudStream` hook; `/(app)/hud/[id]` page with Pertinent + Agent console; live answer streaming. Pertinent derived from board state (overdue/stalled).

**H3 — Drive target + read-only key.** `drive` reader via `src/lib/google/*`; enforce `permissions[]` in `mcp-server.ts`; seed a read-scoped `ApiKey`. Tests: write tools rejected for read-scoped key.

**H4 — suggestion path.** Per decision §7.2: either minimal `ChangeSet` + `propose_changeset` wiring, or comment-based suggestions. Link from HUD → Pending Changes. Metrics hooks (dispatch count, answer latency, suggestion→approval rate).

**H5 (later) — Email/Slack adapters.** Only if §7.1 chooses to build them: `gmail.readonly` scope + Gmail read adapter; Slack OAuth app + read client. Out of scope for the first cut.

Acceptance (first cut, H1–H4): chair starts a HUD on a board, asks *"what's overdue and stalled here?"* and *"find the latest handover doc in Drive"*, both answers stream back with citations within the session, no board row is mutated, and a suggested change appears only as a pending proposal — confirmed by `AgentActivity` provenance and a redelivery/refresh being idempotent.

---

## 9. As built (confirmed decisions)

Implemented per the chair's confirmed answers to §7:

1. **All four targets (Board · Drive · Email · Slack).** The dispatch worker is
   *target-agnostic*: it builds a target-aware, read-only prompt and hands it to
   the external ClaudeMCP agent (decision #3). Because answering happens outside
   this repo, "all four" needs **no in-repo Slack/Gmail client** — the ClaudeMCP
   project holds that access in its own tool config. KanbanMCP still has no Slack
   or Gmail substrate of its own; Email/Slack answers depend entirely on that
   external configuration (documented in `.env.example`).
2. **Minimal ChangeSet now.** `ChangeSet` + `ChangeItem` models, the
   `propose_changeset` MCP tool, a transactional `applyChangeSet`, and the
   `/api/changesets/*` routes (list/detail/decisions/apply) ship in this change.
   Card ops only (`create_card | move_card | update_card | comment_card`);
   commitment ops arrive with the Meeting pipeline.
3. **External ClaudeMCP dispatch** (`src/lib/host-hud/mcp-client.ts` →
   `claude_run`/`claude_job_status`), mirroring `card-execution`.
4. **MCP permission enforcement closed.** `isToolAllowed` in `mcp-server.ts`:
   empty `permissions[]` = legacy full access; a non-empty allowlist requires
   `write` for mutations and `write`/`propose` for proposals. The HUD dispatch
   key is `["read","propose"]` — it can read + propose but cannot mutate, *even
   if prompted to* (covered by tests).

**Files:** schema (`HudSession`, `AgentDispatch`, `ChangeSet`, `ChangeItem`);
`src/lib/host-hud/{mcp-client,dispatch,worker}.ts`; `src/lib/changesets.ts`;
`src/lib/mcp-server.ts` (tools + scoping); `src/app/api/hud/**`,
`src/app/api/changesets/**`; `src/app/(app)/hud/**`; `src/hooks/useHudStream.ts`;
`instrumentation.ts`. Tests under `__tests__/lib/host-hud-*`,
`__tests__/lib/mcp-permissions.test.ts`, `__tests__/mcp/permissions-and-propose.test.ts`.

**Not in this change (honest gaps):** the spec's Meeting/Series/Commitment/
PrepBrief pipeline (the HUD soft-links to it via nullable FKs); a real in-repo
Slack/Gmail integration (delegated to the external ClaudeMCP agent); ChangeSet
expiry; and live verification of the ClaudeMCP round-trip (no ClaudeMCP server
is reachable in CI — the worker is covered by a mocked-client unit test, same as
`card-execution`).
