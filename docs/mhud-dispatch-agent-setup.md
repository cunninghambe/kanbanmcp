# mhud — ClaudeMCP dispatch-agent setup

mhud's in-meeting agents are **read-only** and run on an **external ClaudeMCP server**, not inside this app. The app builds a target-aware prompt, submits it to ClaudeMCP (`claude_run`), and polls for a cited answer; the ClaudeMCP project is where the actual access to boards / Drive / email / Slack lives. If that project isn't configured, `drive`/`email`/`slack` dispatches will simply fail — the app has no built-in Drive/Gmail/Slack client.

This is the missing piece between "the protocol works" (verified end-to-end) and "the feature works in production."

## 1. App-side env

```
CLAUDEMCP_URL=https://<your-claudemcp-host>/mcp   # the streamable-http MCP endpoint
HUD_DISPATCH_PROJECT=mhud-dispatch                 # ClaudeMCP project name (falls back to CLAUDEMCP_PROJECT)
HUD_DISPATCH_MAX_MS=300000                         # per-dispatch timeout (optional)
```

`CLAUDEMCP_URL` must speak the `tools/call` JSON-RPC over the streamable-http `data:` framing and expose `claude_run` (`{project, prompt, timeoutMs}` → `{jobId, state}`) and `claude_job_status` (`{jobId}` → `{state, output, errorDetail?}`), where `output` is the agent's final text. This matches the existing `src/lib/host-hud/mcp-client.ts` and the card-execution client already in the repo.

## 2. The read-scoped mhud API key (board target)

For the `board` target the ClaudeMCP agent should read boards through mhud's own MCP endpoint, and it must be unable to mutate. Create an API key scoped to read + propose only:

- In mhud: **Settings → API keys**, or `POST /api/apikeys` with `{ "agentName": "mhud-dispatch", "permissions": ["read","propose"] }`.
- With `["read","propose"]`, `src/lib/mcp-server.ts` `isToolAllowed` allows the read tools and `propose_changeset`, and **rejects every mutation tool** (`create_card`, `move_card`, …) even if the agent is prompted to call them. (An empty `permissions` array means legacy full access — do NOT use an empty array for this key.)
- Configure the ClaudeMCP project to call mhud at `POST <app>/api/mcp` with `Authorization: Bearer <that key>`.

Even so, the app pre-embeds a read-only board snapshot in the `board` prompt, so a board answer works without any callback; the key matters when the agent needs to `propose_changeset`.

## 3. Per-target tool config on the ClaudeMCP project

The dispatch prompt tells the agent its `TARGET`. Wire the ClaudeMCP project with the matching read-only tools:

| Target | Tools the ClaudeMCP project needs | Notes |
|---|---|---|
| `board` | mhud `/api/mcp` (read-scoped key above) | Answers also work from the embedded board snapshot alone. |
| `drive` | a Google Drive MCP (read-only scopes) | mhud has no Drive client of its own. |
| `email` | a Gmail MCP (read-only) | mhud's `lib/email` is outbound-only; inbox reads live here. |
| `slack` | a Slack MCP (read-only) | No Slack code exists in this repo at all. |

All of these must be **read-only**. The invariant "agents propose, humans approve" is enforced app-side regardless (any board change comes back as a pending ChangeSet), but keeping the external tools read-only is defense in depth.

## 4. Response contract

The agent must return a single fenced ```json block (see `buildDispatchPrompt` in `src/lib/host-hud/dispatch.ts`):

```json
{ "answer": "markdown", "citations": [{ "kind": "card|doc|email|message", "id": "...", "title": "...", "url": "...", "quote": "..." }], "confidence": 0.0, "suggestion": null }
```

`suggestion` is `null` unless proposing a board change; when present it becomes a **pending ChangeSet** (never applied live) with `op`s drawn from `create_card | move_card | update_card | comment_card`. Parsing is tolerant (bare JSON or raw text fall back to an answer with no citations).

## 5. Local dev / testing note

`DATABASE_URL` `file:` paths resolve **relative to the `prisma/` schema directory**, not the repo root. So `file:./kanban.db` (as in `.env.example`) becomes `prisma/kanban.db`, and `file:./prisma/kanban.db` nests to `prisma/prisma/kanban.db`. Pick one and be consistent.
