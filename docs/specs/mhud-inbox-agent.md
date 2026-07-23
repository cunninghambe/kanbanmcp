# mhud Inbox Agent — Spec & Build Plan

**Status:** Ready for implementation · **Goal:** the user never opens Gmail. The inbox's needs are presented inside mhud — cards for what needs doing, a nudge banner for what's urgent, a reply loop (voice note → agent draft → one-tap approve) that never leaves the card.

**Architecture (three pieces, two owned here):**

```
Gmail ──► Apps Script agent (Google's infra, 30-min trigger)
              │  classify: hard rules → Haiku (fail-safe: ACTIONABLE)
              │
              ├─► mhud /api/mcp  · create_card (triage/urgent/digest cards)
              │                  · create_nudge (urgent banner)      [Bearer: write-scoped ApiKey]
              │
              ◄─┐
mhud UI ──► /api/inbox-agent proxy ──► Apps Script /exec (draft | send | ack)
   │            [human session ONLY; token stays server-side]
   └── NudgeBanner (polls /api/nudges) · GmailReplyPanel (on cards tagged gmail:<threadId>)
```

The Apps Script (vendored at `integrations/gmail-apps-script/`) holds Gmail access and the Anthropic key. mhud holds the board, the nudge state, and the human-approval gates. **The send path is human-session-only in mhud** — the same "agents propose, humans approve" invariant as ChangeSets: the script can *draft*, but a send fires only from a human click.

---

## Corrections to the drafted Code.gs (why this spec exists)

The draft in `integrations/gmail-apps-script/` was written blind against mhud's schema. Real contracts (verified against `src/lib/mcp-server.ts` on main):

1. **`create_card` args** — `{ boardId, columnId, title, description?, dueDate?, sprintId?, priority? }`; `priority` MUST be one of `none|low|medium|high|critical`. The draft sends `'urgent'`/`'normal'`, which the handler **rejects with -32602**. Map: URGENT→`critical`, ACTIONABLE/NEEDS_REPLY→`medium`, digest→`low`.
2. **Deadline is droppable data** — the classifier extracts `deadline` (ISO) but the draft never sends it. Wire it to `dueDate`; it powers mhud's overdue/pertinent rails for free.
3. **JSON-RPC errors return HTTP 200** — `/api/mcp` puts failures in `body.error`. The draft only checks the HTTP status, so a failed card create would still archive the email (silent mail loss — the exact failure mode this system promises to never have). The adapter must throw when `body.error` is present, leaving the thread unprocessed for retry.
4. **Card id is `result.id`**, not `result.cardId`.
5. **Nudges** — replace the drafted `NUDGE_WEBHOOK_URL`+`NUDGE_SECRET` ad-hoc webhook and in-memory Map with a first-class `create_nudge` MCP tool over the same `/api/mcp` endpoint and ApiKey the script already holds (one endpoint, one credential, org-scoped, survives restarts). Keep the optional ntfy push in the script.
6. **ApiKey scope** — the script's key needs `permissions: ["write"]` (`create_card` is a WRITE tool per `isToolAllowed`). Do NOT reuse the HUD dispatch key (`["read","propose"]` — it cannot create cards). Do NOT use an empty-permissions legacy key.

---

## WI-A — Backend (nudges, proxy, expiry) — hand to Opus

**Owns:** `prisma/schema.prisma` (additive), `src/lib/mcp-server.ts` (tool + gating additions), `src/app/api/nudges/route.ts`, `src/app/api/nudges/[id]/ack/route.ts`, `src/app/api/inbox-agent/route.ts`, `src/app/api/cron/inbox-expire/route.ts`, `__tests__/mcp/nudges.test.ts`, `__tests__/api/inbox-agent.test.ts`.

### A1. Prisma model (additive; `db push`, no migration files)

```prisma
// ─── Inbox Agent (Gmail triage nudges) ───────────────────────────────────────
model Nudge {
  id            String    @id @default(cuid())
  orgId         String
  // values: urgent_email (only kind for now; string pseudo-enum per repo convention)
  kind          String    @default("urgent_email")
  title         String    // "<sender>: <summary>" — what the banner shows
  summary       String?
  fromLabel     String?   // display sender, e.g. "Jane Doe"
  gmailThreadId String?
  permalink     String?   // Gmail deep link (escape hatch)
  cardId        String?   // the urgent card, when one was created
  // values: pending | acked
  status        String    @default("pending")
  createdById   String    // agentName from the ApiKey
  ackedById     String?
  createdAt     DateTime  @default(now())
  ackedAt       DateTime?

  @@index([orgId, status])
  @@map("nudges")
}
```

### A2. MCP tool `create_nudge` (in `mcp-server.ts`)

- Manifest entry + handler + dispatch-table wire-up, matching existing tool style.
- Input: `{ title (req), summary?, fromLabel?, gmailThreadId?, permalink?, cardId? }`. Org comes from `agentCtx.orgId`; `createdById = agentCtx.agentName`.
- **Gating:** add `'create_nudge'` to `WRITE_TOOLS`.
- **Idempotent per thread:** if a `pending` nudge with the same `(orgId, gmailThreadId)` exists (and `gmailThreadId` given), return it (`{ nudgeId, deduped: true }`) instead of creating a duplicate — Apps Script reruns must not stack banners.
- If `cardId` is provided, verify it belongs to the org (same IDOR pattern as other tools); drop it silently if not.
- `logActivity(orgId, agentName, 'create_nudge', 'nudge', id, { gmailThreadId })`.

### A3. REST for the UI

- `GET /api/nudges` — `requireSession` + `requireOrgRole(MEMBER)`; returns pending nudges for the org, oldest first, each shaped `{ id, title, summary, fromLabel, permalink, cardId, boardId, createdAt }` where `boardId` is resolved from the card (null if card gone). API-key callers may read (harmless).
- `POST /api/nudges/[id]/ack` — **human session ONLY** (reject `isApiKeyAuth` 403). Sets `status='acked'`, `ackedById`, `ackedAt`. Then, if the nudge has a `gmailThreadId` and `INBOX_AGENT_URL`+`INBOX_AGENT_TOKEN` are set, fire-and-forget POST `{ token, action:'ack', threadId }` to the Apps Script so the `ai/urgent` Gmail label clears — UI state and Gmail state stay consistent. Failures logged, never block the ack. Idempotent: acking an acked nudge returns 200.

### A4. `/api/inbox-agent` proxy (the reply loop's server side)

- `POST` only. **Human session ONLY** + `requireOrgRole(MEMBER)` — this route can cause an email send, so API keys are hard-rejected exactly like ChangeSet apply.
- Body (Zod): `{ action: 'draft'|'send'|'ack', threadId?, instructions?, replyAll?, draftId? }` — `draft` requires `threadId`+`instructions` (instructions max ~4000 chars); `send` requires `draftId`; `ack` requires `threadId`.
- Forwards to `process.env.INBOX_AGENT_URL` with `token: process.env.INBOX_AGENT_TOKEN` injected server-side (the token never reaches the browser — this is the whole point of the proxy). 503 if env unset. 15s timeout. Response passed through as JSON (Apps Script returns `{draftId,preview,to} | {sent,messageId} | {acked} | {error}`); map `{error}` to HTTP 502.
- No SSRF surface: the URL comes only from env, never the request.
- `logActivity(orgId, 'inbox-agent', action, 'gmail_thread', threadId ?? draftId, {...})` for `send` at minimum (provenance for every outbound email).

### A5. `POST /api/cron/inbox-expire`

- Bearer `CRON_SECRET` (mirror `cron/digest`). Reads `INBOX_BOARD_ID` (no-op `{expired:0, reason:'unconfigured'}` if unset) and `INBOX_EXPIRE_DAYS` (default 5).
- On that board: cards whose column name is NOT (case-insensitive) `Urgent`, `Digest`, `Done` and whose `updatedAt` < now − N days → move to the column named `Digest` (position: end) + add a comment `Auto-expired from "<col>" after N days without touching — see the daily digest.` If no `Digest` column exists, no-op with `{expired:0, reason:'no_digest_column'}`.
- Urgent is exempt (it has a live nudge + stays in the Gmail inbox as fallback); Digest/Done are terminal.
- Returns `{ expired: n }`. The Apps Script's daily trigger calls this with the CRON_SECRET (documented in SETUP).

### A6. Tests

- `create_nudge` via `handleMcpRequest`: creates; dedupes on same pending thread; **denied for `["read","propose"]` key** (-32004); allowed for `["write"]`.
- ack: human 200 + status flip; API key 403; fires the label-clear callback when env set (mock fetch).
- inbox-agent proxy: API key 403; missing env 503; `draft` forwards with token injected (mock fetch, assert token NOT from client); `{error}` from upstream → 502.
- inbox-expire: moves only stale non-exempt cards; exempts Urgent/Digest/Done; bad bearer 401.

## WI-B — Frontend + vendored script — hand to Sonnet

**Owns:** `src/components/inbox/NudgeBanner.tsx`, `src/app/(app)/layout.tsx` (mount only), `src/components/board/GmailReplyPanel.tsx`, one render-site hookup inside `src/components/board/CardModal.tsx` (minimal diff), `integrations/gmail-apps-script/{Code.gs,SETUP.md}`, `.env.example` (inbox section).

### B1. NudgeBanner

- Client component mounted in `(app)/layout.tsx` above `{children}` — visible on every screen, board included.
- SWR on `/api/nudges`, `refreshInterval: 30_000`, silent on error (the app must never degrade because polling failed).
- Design: **km tokens, not Tailwind reds** — sticky top, `background: var(--accent-tint)`, `border-bottom: 1px solid var(--accent)`, pulsing accent pip (reuse the HUD `pulse` idea), mono eyebrow `/// urgent`, per-nudge row: `**fromLabel**: title`, actions: `open card` (→ `/board/${boardId}` when present), `gmail` (permalink, `target=_blank rel=noreferrer`), `ack` (POST `/api/nudges/[id]/ack`, optimistic removal, revalidate). `role="alert" aria-live="assertive"`. Renders nothing when empty.

### B2. GmailReplyPanel (voice → draft → approve)

- Rendered by `CardModal` only when the card description matches ``/`gmail:([\w-]+)`/`` (the marker the script writes). Keep the CardModal diff to: import + one conditional render passing `threadId` + `cardId`.
- Panel states: **compose** (textarea + 🎤 mic button using `webkitSpeechRecognition`/`SpeechRecognition` when available — graceful hide when not — placeholder "voice-note or type what to say…", `reply all` checkbox) → **drafting** (shimmer) → **preview** (draft body + `to:`, buttons `approve & send` / `re-draft` / `discard`) → **sent** (confirmation + posts a card comment `Replied via inbox agent — <to>` through the existing `/api/cards/[id]/comments`).
- Calls only `/api/inbox-agent` (`draft` then `send`). Surface upstream errors inline (`km-mono`, `var(--err)`); 503 renders "inbox agent not configured".
- Approve is ONE tap once the preview is on screen — friction kills this feature (spec'd requirement).

### B3. Vendored Apps Script (fix per the Corrections section)

- `integrations/gmail-apps-script/Code.gs`: apply corrections 1–5 (priority mapping, `dueDate` from `deadline`, JSON-RPC `body.error` → throw, `result.id`, `fireNudge_` → `create_nudge` via `/api/mcp` with `title = fromLabel + ': ' + summary`, keep ntfy; delete `NUDGE_WEBHOOK_URL`/`NUDGE_SECRET` config). Add optional daily call to `/api/cron/inbox-expire` using a `KANBAN_CRON_SECRET` property (skipped when unset).
- `integrations/gmail-apps-script/SETUP.md`: rewrite for mhud — create the Inbox board (columns `Urgent / Triage / Digest / Done`), mint the ApiKey with `permissions: ["write"]` (explicitly: not the HUD `read,propose` key), Script Properties table, deploy steps, the mhud env vars (below), and the first-month audit protocol (digest card review, VIP tuning, fail-safe behaviour).

### B4. `.env.example`

```
# mhud inbox agent (Gmail triage → board; see docs/specs/mhud-inbox-agent.md
# and integrations/gmail-apps-script/SETUP.md)
INBOX_AGENT_URL=       # Apps Script web-app /exec URL (draft|send|ack proxy target)
INBOX_AGENT_TOKEN=     # shared secret; server-side only, never shipped to the browser
INBOX_BOARD_ID=        # board that receives triage cards (enables /api/cron/inbox-expire)
INBOX_EXPIRE_DAYS=5    # untouched triage cards roll into the Digest column after this
```

---

## Invariants (non-negotiable, mirror the HUD's)

1. **No silent mail loss.** Classifier failure → ACTIONABLE card; card-create failure → thread left unprocessed for retry (correction 3); urgent mail never auto-archived.
2. **Sends are human-gated.** Only `/api/inbox-agent` can trigger a send; it rejects API keys. The script's ApiKey can create cards and nudges — it cannot send mail through mhud, and mhud cannot send mail except from a human click.
3. **Secrets stay server-side.** `INBOX_AGENT_TOKEN` never appears in client code; the Apps Script token model depends on it.
4. **Provenance.** Card/nudge creation and every send logs `AgentActivity`.

## Acceptance

- A `["write"]` key can `create_card` (valid priorities) and `create_nudge` (deduped); a `["read","propose"]` key is denied both.
- A pending nudge renders the banner within 30s; ack clears it, survives refresh (DB-backed), and fires the Gmail label-clear callback.
- On a card carrying `` `gmail:<id>` ``, the full voice→draft→preview→approve→send loop works against a mocked `/api/inbox-agent` upstream; the send posts a card comment.
- Stale Triage cards (and only those) roll into Digest via the cron; Urgent/Digest/Done untouched.
- `next build`, `tsc`, eslint clean; new tests green; existing suite unaffected (the two `sqlite3`-CLI suites remain env-red locally, green in CI).

## Deferred (tracked, out of scope)

- In-app voice transcription beyond Web Speech API (Whisper etc.).
- Nudge push into the HUD SSE stream (banner polling is sufficient at this volume).
- Per-sender VIP management UI (Script Properties for now).
- Threading digest cards by week; retention/cleanup of acked nudges.
