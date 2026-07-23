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

Create a board (any name — "Inbox" works) with these columns, in order:

| Column | Purpose |
|---|---|
| **Urgent** | URGENT bucket. Stays in the Gmail inbox too — this is a mirror, not the only copy. Exempt from auto-expiry. |
| **Triage** | ACTIONABLE / NEEDS_REPLY buckets. Untouched cards roll into Digest after `INBOX_EXPIRE_DAYS` (default 5) via the cron below. |
| **Digest** | Daily FYI/noise audit card, plus anything that expired out of Triage. Terminal — never auto-expired. |
| **Done** | Where you drag things once handled. Terminal — never auto-expired. |

Copy each column's ID (visible in the board UI / API) for the Script
Properties table below.

## 2. Mint the ApiKey

Create an ApiKey scoped `permissions: ["write"]`. This is the key that lets
the script call `create_card` and `create_nudge` (both are `WRITE_TOOLS` in
`mcp-server.ts`).

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
| `KANBAN_BOARD_ID` | yes | the Inbox board's ID |
| `COL_URGENT` | yes | Urgent column ID |
| `COL_TRIAGE` | yes | Triage column ID |
| `COL_DIGEST` | yes | Digest column ID |
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
4. Run `triage()` once manually and watch the execution log — confirm
   cards land in the right columns with the right priorities before
   trusting the 30-min trigger.
5. Deploy → New deployment → **Web app**, execute as *Me*, access
   *Anyone*. Copy the `/exec` URL — that's `INBOX_AGENT_URL` below. Auth on
   this endpoint is the `WEBHOOK_TOKEN` carried in the JSON body (an Apps
   Script web app deployed with "Anyone" access is public internet with
   token auth — fine for this threat model since the token never reaches
   client-side code; see step 4 below).

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
