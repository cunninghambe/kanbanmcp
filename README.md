# KanbanMCP

An AI-first Kanban board with first-class agent access via MCP, helpdesk ticketing, and a sub-issue tree with optional Claude-powered artifact + description review.

Built with Next.js 16 (App Router), Prisma + SQLite, iron-session, and the Anthropic SDK.

## Features

- **Board + columns + cards** with assignees, sprints, labels, priorities, due dates
- **Review workflow (M1):** required assignee, optional reviewer, optional approver per card; advisory signoffs (APPROVED / REJECTED / REQUESTED_CHANGES)
- **Sub-issues:** unlimited nesting via materialised path (`/parentId/grandparentId/...`); UI collapses past depth 3; max depth 50
- **AI review:**
  - Toggle per card (`aiAutoReview: boolean`)
  - Reviews uploaded artifacts (PDF, text, images) AND card descriptions
  - Per-card `aiReviewParams` (`model`, `rubric`, `customInstructions`) with inheritance from ancestors and env fallback
  - In-process queue, 3-retry exponential backoff, comment posted by an "AI Reviewer" service user
- **Artifacts:** multipart upload, MIME allowlist, 25 MB cap, local-disk or S3 storage driver
- **Assigned-to-me feed:** dashboard widget + avatar badge + daily email digest endpoint (`POST /api/cron/digest` with bearer auth)
- **MCP integration:** JSON-RPC endpoint at `/api/mcp` with 11 tools (board CRUD, cards, signoffs, AI review, sub-card tree)
- **Helpdesk tickets:** separate ticket system with REST API
- **Auth:** iron-session cookies + API keys for agents

## Quick start

```bash
# Install (the project ships .npmrc include=dev to handle servers
# that set NODE_ENV=production globally — npm install just works)
npm install

# Required env (copy .env.example to .env and fill in)
cp .env.example .env

# At minimum set:
#   SESSION_SECRET=<random>
#   DATABASE_URL=file:./kanban.db
#   ANTHROPIC_API_KEY=<sk-ant-...>      # for AI review
#   AI_REVIEW_DEFAULT_MODEL=claude-sonnet-4-6
#   AI_REVIEW_DEFAULT_RUBRIC=<your default rubric prompt>

# Apply schema and seed demo data (idempotent)
npm run db:push
npm run db:seed

# Capture the AI Reviewer service-user id (optional but skips a lookup on every worker boot)
npm run db:seed-ai-reviewer       # prints `[seed-ai-reviewer] id=<cuid>` — paste into .env

# Run the dev server
npm run dev                       # http://localhost:3002

# Login as admin@demo.com / demo1234
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server with Turbopack |
| `npm run build` | Production build |
| `npm test` | Vitest unit + integration suite (484 tests) |
| `npm run e2e` | Playwright browser tests (against dev server) |
| `npm run smoke` | Destroys local DB, re-applies schema, re-seeds, runs full test suite (manual smoke) |
| `npm run lint` | ESLint |
| `npm run db:push` | Apply schema to SQLite (non-destructive) |
| `npm run db:seed` | Seed demo org + admin user + sample board (idempotent) |
| `npm run db:seed-ai-reviewer` | Seed the AI Reviewer service user |
| `npm run upload-sourcemaps` | Manually re-run the uh-oh source map upload + cleanup (see Deploy) without rebuilding |

## Deploy

Production runs under pm2 as `kanban` (`scripts/start.sh` is the pm2 entrypoint:
it applies pending Prisma migrations non-destructively, then `exec`s
`next start`). The `surfacemcp-kanbanmcp` app in `ecosystem.config.cjs` is an
unrelated dev-tooling MCP surface, not this app.

The documented deploy sequence, run on the host (e.g. `/opt/kanban`):

```bash
git pull                # or checkout the release branch
npx prisma generate
npm run build            # also runs postbuild (see below)
pm2 restart kanban
```

### uh-oh source maps

`npm run build` automatically triggers `postbuild`
(`scripts/uh-oh-postbuild.mjs`), which uploads that build's `.next` source
maps to the uh-oh server and deletes the browser copies, using the same
`<version>+0` release string the app's own `instrumentation.ts` reports
crashes under.

- **To enable it for a deploy:** export `UH_OH_SERVER_URL`,
  `UH_OH_SYMBOL_TOKEN`, and `UH_OH_PROJECT` in the shell that runs
  `npm run build` (deploy-time only - see `.env.example`; the running app
  never reads them, so do not add them to the app's runtime env / pm2 env).
- **If they are unset,** the build produces no source maps at all
  (`next.config.js` gates `productionBrowserSourceMaps` /
  `experimental.serverSourceMaps` on their presence) and the upload script
  prints one line and exits 0 - a normal deploy is unaffected either way.

**Public-map safety guarantee:** `next start` serves `.next/static` as-is, so
a browser `.js.map` left on disk after a build would be publicly fetchable.
Two independent layers prevent that:
1. Maps are only ever generated when the three envs above are present at
   build time (otherwise there is nothing to leak in the first place).
2. When they are generated, `scripts/uh-oh-postbuild.mjs` always finishes
   with an unconditional sweep of `.next/static/**/*.js.map`, regardless of
   whether the upload fully succeeded, partially failed (the vendored
   uploader's `--delete-browser-maps` only deletes what it actually
   uploaded), or was skipped - so no deploy can ship a public source map.

Server-side maps (`.next/server/**`) are never served over HTTP by
`next start`, so they are uploaded but not swept.

## Architecture

```
src/
  app/
    api/                # Next.js 16 route handlers (params as Promise<{}>)
      auth/             # login, logout, register, me
      boards/           # board CRUD, board cards
      cards/[cardId]/   # card CRUD, children, promote, reparent, artifacts,
                        # signoffs, reviews (description-only)
      artifacts/        # download, delete, manual review trigger
      reviews/          # AI review status lookup
      mcp/              # JSON-RPC endpoint for agents
      me/               # assignments feed
      cron/digest/      # daily email digest (bearer auth)
      orgs/             # org membership management
      sprints/          # sprint CRUD
      tickets/          # helpdesk tickets
      webhooks/         # outbound webhooks
    (app)/              # authenticated app pages: dashboard, board, sprints, etc.
  components/board/     # CardModal, CardDetailSections, SubcardTree, RoleSelector,
                        # AiReviewToggle, ArtifactList, SignoffPanel
  components/dashboard/ # AssignmentWidget
  components/layout/    # Sidebar with avatar + assignment badge
  lib/
    ai-review/          # worker, queue, extractors (PDF/text/image), claude-client,
                        # inheritance walker
    email/              # pluggable provider (log default; resend stub for M2)
    tree.ts             # subtree path recompute, cycle detection
    cards.ts            # shared card helpers (Zod schemas, role IDOR check)
    storage.ts          # local-disk + S3 driver abstraction
    resolve-card.ts     # cross-org-safe card lookup (returns 404 not 403)
    session.ts          # iron-session config
    api-helpers.ts      # requireSession, requireOrgRole, apiError
  proxy.ts              # Next.js 16 proxy/middleware (auth + rate limit)

prisma/
  schema.prisma         # All models
  migrations/           # SQLite migrations
  seed.ts               # Demo data (idempotent)
  seed-ai-reviewer.ts   # Service user

e2e/                    # Playwright browser tests
__tests__/              # Vitest suite
docs/specs/             # M1 spec + task briefs
docs/POST_M1_FOLLOWUPS.md
```

## API conventions

- **Auth:** session cookie OR `Authorization: Bearer <api-key>` (agents). Both gated by `requireSession` + `requireOrgRole`.
- **Cross-org access:** returns `404 Card not found` (not `403`) to prevent ID enumeration across orgs.
- **IDOR on user-id fields:** every `assigneeId`, `reviewerId`, `approverId`, `uploaderId` validated as a member of the session's org before write.
- **Zod at boundaries:** every request body validated; 400 on validation failure.
- **Tree paths:** materialised, leading slash, format `/grandparentId/parentId/`. Empty string for root.

## AI review pipeline

```
Upload artifact → POST /api/cards/[id]/artifacts (multipart)
    OR
Trigger card-level review → POST /api/cards/[id]/reviews

  ↓ (if card.aiAutoReview === true OR explicit POST)

Enqueue AiReview { status: pending }
  ↓
Worker (single concurrency)
  - Resolve params via inheritance walker (card → ancestor chain → env defaults)
  - Fetch content (artifact bytes / card description)
  - Extract: PDF (pdf-parse, 10 MB cap) | text | image base64 (5 MB cap)
  - Call Claude with rubric as system prompt, content as user message
  - Retry 3x with exponential backoff on 429/5xx; permanent on 4xx
  ↓
status: done | failed | skipped
  ↓
Post comment on card as the AI Reviewer service user
```

## MCP tools

Available at `POST /api/mcp` (JSON-RPC). Bearer-auth via API key.

| Tool | Purpose |
|---|---|
| `get_board` | Get a board with columns and cards |
| `create_card` | Create a top-level card |
| `move_card` | Move a card between columns |
| `update_card` | Update card fields |
| `add_comment` | Post a comment |
| `create_subcard` | Create a child card under a parent |
| `set_card_reviewers` | Set reviewer/approver |
| `toggle_ai_review` | Enable/disable AI auto-review + set params |
| `list_card_tree` | List subtree to a depth |
| `record_signoff` | Returns -32602 (M1: signoffs require a human session) |
| `list_artifacts` | List artifacts on a card |

Manifest: `GET /api/mcp` (no auth).

## Security posture

- 5 security headers set globally in `next.config.js` (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS-prod)
- iron-session cookies: `httpOnly`, `sameSite: strict`, `secure` in production
- bcrypt cost factor 12 for password hashes
- AI Reviewer service user has `isAgent: true` — login route blocks `isAgent=true` accounts after a constant-time bcrypt compare (no timing oracle)
- API-key auth carries `userId = ''` so it can never match a real user ID (used to block agent signoffs and similar role-gated endpoints)
- `npm audit --omit=dev`: 0 HIGH (Next.js 16.2.6 cleared the prior 4 HIGHs). 2 moderate remain — both transitive PostCSS inside Next 16, upstream issue.

## Tests

- **Unit + integration:** 484 tests across 45 files, all passing. `npm test`.
- **End-to-end:** 17 Playwright tests across 10 spec files, all passing — login, card create + roles, sub-card tree (nest + promote), signoff workflow, artifact upload + MIME/size rejects, real-Claude AI auto-review (artifact + description, captures inputTokens), assigned-to-me widget + badge, former-member assignee, reparent cycle detection. `npm run e2e`. Real-Claude tests use either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; skip gracefully if neither is set.
- **Smoke:** `scripts/smoke.sh` destroys the dev DB, re-applies schema, re-seeds, runs the full unit suite. `npm run smoke`.
- **Migrations:** `npx prisma migrate deploy` on a fresh DB succeeds.

## Roadmap

See [`docs/POST_M1_FOLLOWUPS.md`](docs/POST_M1_FOLLOWUPS.md) for the post-M1 status board.

**M2 (planned):** External-doc AI review — OAuth, Google Drive / Docs / Sheets / Slides content adapters, per-user identity for fetching, permission handling on revoked-access mid-review.

**M3 (planned):** Hard column-transition gating on signoffs, webhook payload changes for review events.

## Repo conventions

- TypeScript strict mode
- Zod at every API boundary
- React: functional components, SWR for server state, no global client store
- Prettier formatting (run `npx prettier --write .`)
- Exact dep versions in `package.json` (no `^` ranges) so production drift is intentional, not silent
