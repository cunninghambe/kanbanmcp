# mhud Inbox Agent — Setup

Two pieces: the Apps Script (`Code.gs`, runs entirely in your Google
account) and mhud itself, which already ships the nudge banner
(`NudgeBanner`, polling `GET /api/nudges`), the reply loop
(`GmailReplyPanel`, on any card whose description contains
`` `gmail:<threadId>` ``), and the human-approval proxy (`/api/inbox-agent`).
There is nothing left to build on the mhud side — this doc only covers
provisioning the board, the API key, and the script.

See `docs/specs/mhud-inbox-agent.md` for the full architecture and the
"Corrections to the drafted Code.gs" section this script implements.

## 1. Create the Inbox board in mhud

Create an empty board named **Inbox** (or any name — set `KANBAN_BOARD_NAME`
if different) and stop there. **You do not rename columns and you never copy
a column or board ID**: the script's `setupBoard()` resolves the board by
name, finds-or-creates the three columns it needs via
`POST /api/boards/<id>/columns`, and caches every ID into its own Script
Properties. mhud has no column rename, so the board's default columns
(Backlog / In Progress / Review / Done) simply stay — the agent ignores
them. Keep this board dedicated to the inbox agent.

The columns the script creates and how it uses them:

| Column | Purpose |
|---|---|
| **Urgent** | URGENT bucket. Stays in the Gmail inbox too — this is a mirror, not the only copy. Exempt from auto-expiry. |
| **Triage** | ACTIONABLE / NEEDS_REPLY buckets. Untouched cards roll into Digest after `INBOX_EXPIRE_DAYS` (default 5) via the cron below. |
| **Digest** | Daily FYI/noise audit card, plus anything that expired out of Triage. Terminal — never auto-expired. |
| **Done** | The board's default Done column — drag things here once handled. Terminal — never auto-expired. |

## 2. Mint the ApiKey

Create an ApiKey scoped `permissions: ["write"]` (Settings → API keys).
This is the key that lets the script call `create_card` and `create_nudge`
(both are `WRITE_TOOLS` in `mcp-server.ts`). **ApiKeys are org-scoped:
mint it while you're in the same org that owns the Inbox board**, or
`setupBoard()` won't be able to see the board.

**Do NOT** reuse:
- the HUD dispatch key (`permissions: ["read","propose"]`) — it can read
  and propose changesets but is denied every mutation tool, including
  `create_card` and `create_nudge`, with a `-32004` error.
- a legacy empty-permissions key (`permissions: []`) — those are
  back-compat full-access keys; using one here works but defeats the point
  of a scoped credential for an unattended script holding your Gmail
  access.

## 3. Apps Script

1. [script.new](https://script.new) → paste `Code.gs` into the editor.
2. Project Settings → Script Properties, add:

| Property | Required | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | your Anthropic API key |
| `KANBAN_MCP_URL` | yes | `https://<your-mhud-host>/api/mcp` |
| `KANBAN_API_KEY` | yes | the `["write"]` ApiKey from step 2 |
| `KANBAN_BOARD_NAME` | optional | board name for auto-resolution (default `Inbox`) |
| `KANBAN_BOARD_ID` | optional | only if you prefer pinning by ID (it's in the `/board/<id>` URL); otherwise `setupBoard()` fills it |
| `COL_URGENT` / `COL_TRIAGE` / `COL_DIGEST` | auto | managed by `setupBoard()` — never fill these by hand |
| `WEBHOOK_TOKEN` | yes | random long secret — shared with mhud's `INBOX_AGENT_TOKEN` (below) |
| `KANBAN_CRON_SECRET` | optional | mirrors mhud's `CRON_SECRET`; enables the daily `expireTriage()` call to `/api/cron/inbox-expire`. Leave unset to skip it (rolling stale Triage cards into Digest then becomes a manual chore). |
| `NTFY_TOPIC` | optional | a private [ntfy.sh](https://ntfy.sh) topic for a phone push on every URGENT nudge, alongside the in-app banner |
| `CLASSIFY_MODEL` | optional | defaults to `claude-haiku-4-5-20251001` |
| `DRAFT_MODEL` | optional | defaults to `claude-sonnet-4-6` |
| `VIP_SENDERS` | optional | comma-separated senders/domains that always classify URGENT, no LLM involved — e.g. `anthropic.com,greenhouse.io,lever.co,docusign` |
| `VOICE_NOTES` | optional | style notes injected into every reply draft |
| `BATCH_SIZE` | optional | threads pulled per triage run (default 15) |
| `BODY_CHARS` | optional | chars of body sent to the classifier per email (default 1500) |

3. Run `setup()` once. Approve the OAuth scopes (Gmail + external
   requests). This creates the `ai/*` labels and installs three triggers:
   `triage` every 30 min, `dailyDigest` at 07:30, `expireTriage` at 06:00.
4. Run `setupBoard()` once and check the log: it resolves the board,
   creates the Urgent/Triage/Digest columns, and prints every ID —
   including the `KANBAN_BOARD_ID` value you'll reuse as `INBOX_BOARD_ID`
   in step 4. (Forgetting this step is harmless: `triage()` runs it
   automatically the first time.)
5. Run `triage()` once manually and watch the execution log — confirm
   cards land in the right columns with the right priorities before
   trusting the 30-min trigger.
6. Deploy → New deployment → **Web app**, execute as *Me*, access
   *Anyone*. Copy the `/exec` URL — that's `INBOX_AGENT_URL` below. Auth on
   this endpoint is the `WEBHOOK_TOKEN` carried in the JSON body (an Apps
   Script web app deployed with "Anyone" access is public internet with
   token auth — fine for this threat model since the token never reaches
   client-side code; see step 4 below).

**Deploy-order note:** card triage works against any mhud build (the
`create_card` tool and the columns endpoint are long-standing). The nudge
banner, `create_nudge`, the reply panel, `/api/inbox-agent`, and
`/api/cron/inbox-expire` only exist from the inbox-agent release onward —
on an older deployment the script still triages (a failed `create_nudge`
is caught and logged; the `ai/urgent` label and optional ntfy push still
fire), and the rest lights up when you deploy the new build.

## 4. mhud environment variables

Set these on the mhud deployment (`.env` — see `.env.example`):

```
INBOX_AGENT_URL=       # the /exec URL from step 3.5
INBOX_AGENT_TOKEN=     # same value as WEBHOOK_TOKEN above — server-side only, never shipped to the browser
INBOX_BOARD_ID=        # the Inbox board's ID (enables POST /api/cron/inbox-expire)
INBOX_EXPIRE_DAYS=5    # untouched Triage cards roll into Digest after this many days
```

`INBOX_AGENT_TOKEN` is read only by `/api/inbox-agent` and the nudge-ack
label-clear callback, both server routes — it is injected into the
upstream request server-side and is never sent to the browser. This is the
entire reason that proxy exists instead of the browser calling the Apps
Script `/exec` URL directly.

If you already run the digest cron (`CRON_SECRET`, `/api/cron/digest`),
`KANBAN_CRON_SECRET` on the script side should match `CRON_SECRET` on the
mhud side — `/api/cron/inbox-expire` uses the same bearer.

## 5. First-month audit protocol

- Read the 07:30 digest card daily. It lists everything archived as FYI or
  noise in the last 24h. Misfiles get fixed by adding senders to
  `VIP_SENDERS` or sharpening the classifier prompt in `classifyBatch_()`,
  not by reopening Gmail.
- Classifier outage fails safe: `triage()` catches classifier errors and
  falls every unclassified email through to ACTIONABLE, so an Anthropic
  outage produces extra Triage cards, never silent archiving. Watch the
  execution log for `Classifier failed, failing safe to ACTIONABLE` — if
  you see it a lot, something's wrong upstream.
- Dispatch failures (a `create_card`/`create_nudge` RPC error, or mhud
  being unreachable) leave the thread's `ai/processed` label off, so the
  next 30-min run retries it automatically. Nothing is silently dropped.
- Watch the Urgent nudge banner in mhud for a few days against the
  `ai/urgent` Gmail label directly — they should track each other exactly
  (ack in mhud clears the Gmail label via the callback in
  `POST /api/nudges/[id]/ack`; a mismatch there is a bug, not a config gap).
- Untouched Triage cards auto-expire into Digest after `INBOX_EXPIRE_DAYS`
  days via the cron — confirm at least one has actually moved before
  relying on it; without `KANBAN_CRON_SECRET`/`CRON_SECRET` configured on
  both sides this silently never fires and Triage becomes a second inbox.
