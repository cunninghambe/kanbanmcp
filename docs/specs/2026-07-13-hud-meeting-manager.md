# HUD Meeting Manager — Design & Architecture

**Status:** Design locked · 2026-07-13
**Branch:** `feat/hud-meeting-manager` (off `main` @ 4e2e48c0)
**Extends:** `docs/specs/host-meeting-hud-addendum.md` (as-built §9) and
`docs/specs/2026-06-17-hud-card-movement-and-console-hardening.md`
**Verdict on scope:** incremental changes, NOT a redesign. The HUD's existing
architecture (HudSession/AgentDispatch/ChangeSet, propose→approve trust model,
promise-chain worker, SSE-over-polling) is sound and everything below composes
onto it additively. Nothing existing is migrated or broken.

**Explicitly out of scope (do not build here):**
- Anything from the hardening batch (input caps, citation URL handling, dispatch
  cancel propagation, target capability gating, board-snapshot truncation) —
  that work is specced and implemented separately on `fix/hud-hardening`.
- Meeting/Series/Commitment/PrepBrief models, recurrence, "since last meeting"
  cross-session deltas.
- Posting the digest anywhere (board comment, email). v1 is copy-to-clipboard.
- SSE transport consolidation (`hud_context` event).
- No LLM calls anywhere in this spec. All new code paths are deterministic.

---

## 1. Problem Statement

The Host Meeting HUD is an async Q&A console with situational awareness, but a
meeting chair cannot *manage a meeting* with it: there is no way to capture an
action item as a task, no agenda, no notes/decisions log, and ending a session
discards its value with no recap. Separately, the agent-proposal loop leaks —
proposals cannot be rejected from the UI, never expire, are orphaned once a
session ends (no global view), and render as raw JSON. This work makes the HUD
a functional meeting manager for the chair: capture work as it's spoken, run an
agenda, log decisions, and leave the meeting with a digest and a closed loop on
every proposal.

## 2. Boundaries

**Does:**
- Adds a `HudEntry` model: agenda items, notes, decisions, and action items on
  a HUD session, created by the human chair (never by agents).
- Deterministic quick-capture parsing (`@assignee`, `due:` tokens) — pure
  function, no LLM.
- One-click conversion of an action entry into a real card on the session's
  board (human-initiated direct creation; the propose→approve invariant applies
  to *agents*, not the chair).
- A computed end-of-session digest (JSON + markdown) and a wrap-up view.
- ChangeSet reject (wires the existing, unused `decisions` route into the UI),
  lazy TTL expiry for pending sets, a global `/changes` page, and
  human-readable rendering of change ops.
- Pertinent-rail upgrades: due-this-week and moved-this-session groups, and
  card deep-links (`/board/[id]?card=<cardId>`).

**Does NOT:**
- Let agents create/modify HudEntries (all entry routes are human-session-only,
  same gate as dispatch: reject `session.isApiKeyAuth`).
- Apply any board change without explicit human action (unchanged invariant).
- Add npm dependencies. Reuses Prisma, zod, SWR, existing design components.
- Change the dispatch worker, mcp-client, or prompt building at all.

**External dependencies:** none new.

## 3. Interface Contract

### 3.1 Schema (additive, SQLite-safe, `prisma db push` — this repo has no
migration baseline; never `migrate deploy`)

```prisma
// ─── HUD meeting entries (human-authored; agenda/notes/decisions/actions) ────
model HudEntry {
  id           String    @id @default(cuid())
  orgId        String
  hudSessionId String
  authorId     String // human User id — entries are never agent-authored
  // values: agenda | note | decision | action
  kind         String
  text         String
  position     Int       @default(0) // ordering within (session, kind)
  checkedAt    DateTime? // agenda: when checked off
  assigneeId   String? // action: resolved org member
  dueDate      DateTime? // action: parsed due date
  cardId       String? // action: card created from this entry
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  hudSession HudSession @relation(fields: [hudSessionId], references: [id], onDelete: Cascade)

  @@index([hudSessionId, kind, position])
  @@map("hud_entries")
}
```

Plus on `HudSession`: `entries HudEntry[]` back-relation. No other model changes.

`ChangeSet` gains **no columns** — expiry derives from `status == 'pending'`
and `createdAt` (see 3.4).

### 3.2 Capture parser — `src/lib/host-hud/capture.ts` (pure, no I/O)

```ts
export interface ParsedCapture {
  /** Residual text with recognized tokens removed and whitespace collapsed. */
  text: string
  /** First `@word` token (without the @), or null. Unresolved — server matches it. */
  assigneeQuery: string | null
  /** Resolved from the first recognized `due:` token, or null. */
  dueDate: Date | null
}

export function parseCapture(raw: string, now: Date): ParsedCapture
```

Token rules (deterministic):
- `@word`: recognized only at a word boundary (start of string or preceded by
  whitespace). First occurrence is extracted; later `@` tokens stay in text.
  A bare `@` with no following word char is not a token.
- `due:` tokens, first recognized occurrence extracted; forms:
  - `due:YYYY-MM-DD` → that date (local midnight). Invalid calendar date → not
    recognized, stays in text.
  - `due:today` / `due:tomorrow`
  - `due:mon|tue|wed|thu|fri|sat|sun` → the NEXT occurrence of that weekday
    strictly after `now` (if today is Friday, `due:fri` = today + 7 days).
  - Anything else after `due:` → not recognized, stays in text.
- Matching is case-insensitive for `due:` forms; `@word` preserves case in
  `assigneeQuery`.
- `text` after stripping: collapse runs of whitespace to single spaces, trim.

This is an independently-callable parser → the **detector-contract-tests**
four-shape contract applies (positive, negative/FP-boundary, ≥2 edge cases,
input degradation). See plan Task 1 for the concrete case table.

### 3.3 Entry routes (all follow existing `api-helpers` patterns; every
mutating route rejects `session.isApiKeyAuth` with 403 exactly like
`POST /api/hud/[id]/dispatch`)

```
GET    /api/hud/[id]/entries                 → { entries: Entry[] }   (org MEMBER)
POST   /api/hud/[id]/entries                 → { entry, assigneeResolution } 201
PATCH  /api/hud/entries/[entryId]            → { entry }
DELETE /api/hud/entries/[entryId]            → { ok: true }
POST   /api/hud/entries/[entryId]/card       → { entry, card } 201
```

Zod schemas:

```ts
const createEntrySchema = z.object({
  kind: z.enum(['agenda', 'note', 'decision', 'action']),
  text: z.string().trim().min(1).max(2000),
  position: z.number().int().min(0).optional(), // agenda ordering; default = max+1 within (session, kind)
})

const patchEntrySchema = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  checked: z.boolean().optional(),        // agenda only → sets/clears checkedAt server-side
  position: z.number().int().min(0).optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
}).refine((v) => Object.keys(v).length > 0)

const convertSchema = z.object({
  columnId: z.string().optional(), // default: leftmost column of the session board
})
```

POST semantics by kind:
- `action`: server runs `parseCapture(text, new Date())`; stores residual
  `text`, `dueDate`; resolves `assigneeQuery` against org members (see below);
  response includes `assigneeResolution: 'resolved' | 'none' | 'ambiguous'`
  plus `candidates: {id, name}[]` (max 5) when ambiguous.
- `agenda` / `note` / `decision`: text stored verbatim (no token parsing).

Assignee resolution (server, in the route): case-insensitive prefix match of
`assigneeQuery` against org members' `name` and `email` local-part. Exactly one
match → set `assigneeId`; zero → `'none'`; multiple → `'ambiguous'`, entry
saved unassigned. Members come from the same query the existing
`/api/orgs/[orgId]/members` route uses.

Session-state gates:
- POST entries / PATCH / DELETE: session must be `live`, else 409 — EXCEPT
  `PATCH { checked }` on agenda and the convert route, which are also allowed
  on `ended` sessions (post-meeting cleanup).
- Convert (`/card`): entry.kind must be `action` (400 otherwise); session must
  have `boardId` (409 `'Attach a board to create cards'`); entry.cardId already
  set → 409; provided `columnId` must belong to the session board (400).
  Creates the card mirroring the `create_card` op in `src/lib/changesets.ts`
  (org-scoped column lookup, position appended at end of column): title =
  entry.text (≤ 200 chars; longer → truncate title, full text into card
  description), `assigneeId`, `dueDate` carried over. Sets `entry.cardId`,
  fire-and-forget `logActivity(orgId, <chair user id>, 'capture_action_card',
  'card', card.id, { hudSessionId, entryId })`. Card creation and entry update
  run in one `prisma.$transaction`.

### 3.4 ChangeSet loop

**Lazy expiry** — in `src/lib/changesets.ts`:

```ts
export function changeSetTtlDays(): number  // env CHANGESET_TTL_DAYS, default 14, min 1
/** Marks org's stale `pending` sets `expired`. Returns count. Only `pending`
 *  expires — `partially_applied` never does (a human already started deciding). */
export async function expireStaleChangeSets(db: PrismaClient, orgId: string, now: Date): Promise<number>
```

Called at the top of `GET /api/changesets` and `GET /api/changesets/[id]`
(before reading). The existing apply route already only accepts
`pending | partially_applied`, so expired sets are automatically un-appliable.

**Decision status recompute** — in `POST /api/changesets/[id]/decisions`,
after the existing per-item transaction: if every item's decision is
`rejected` → set ChangeSet `status: 'rejected'`. (Mixed/partial decisions leave
status untouched; apply already manages `applied`/`partially_applied`.)

**Human-readable ops** — new pure module `src/lib/changesets-display.ts`:

```ts
export interface ChangeItemDisplay { itemId: string; display: string }
/** Resolves card/column/board ids in op payloads to names; one batched read
 *  per changeset, no N+1. Missing referents degrade to the raw id, e.g.
 *  'Move card cm…x1 (not found) from "In Progress" to "Done"'. */
export async function describeChangeItems(
  db: PrismaClient,
  items: Array<{ id: string; op: string; payload: string; targetCardId: string | null }>
): Promise<ChangeItemDisplay[]>
```

Display formats (exact):
- `create_card` → `Create card "«title»" in «column name» on «board name»`
- `move_card` → `Move "«card title»" from «current column name» to «target column name»`
- `update_card` → `Update "«card title»": «field: value» pairs, comma-joined` (e.g. `priority: high, due: 2026-07-20`)
- `comment_card` → `Comment on "«card title»": "«first 80 chars of text»…"`

`GET /api/changesets/[id]` response items each gain `display: string`.
`GET /api/changesets` list rows gain `hudSessionTitle: string | null`
(joined from `hudSessionId`).

### 3.5 Digest — `src/lib/host-hud/digest.ts` (pure over pre-fetched rows) +
`GET /api/hud/[id]/digest`

```ts
export interface DigestInput {
  session: { id: string; title: string; startedAt: Date; endedAt: Date | null }
  boardName: string | null
  entries: HudEntry[]              // all kinds, ordered (kind, position, createdAt)
  dispatches: Array<Pick<AgentDispatch, 'target' | 'question' | 'status' | 'answer'>>
  changeSets: Array<{ id: string; status: string; summary: string | null; itemCount: number }>
  memberNames: Map<string, string> // assigneeId → display name
}
export interface Digest {
  stats: {
    durationMs: number | null
    dispatches: number; answered: number; failed: number
    proposals: number; proposalsPending: number
    actions: number; actionsWithCards: number
    decisions: number; notes: number
    agendaDone: number; agendaTotal: number
  }
  agenda: Array<{ text: string; checked: boolean }>
  decisions: Array<{ text: string; at: string }>
  notes: Array<{ text: string; at: string }>
  actions: Array<{ text: string; assigneeName: string | null; dueDate: string | null; cardId: string | null }>
  dispatches: Array<{ target: string; question: string; status: string; answerExcerpt: string | null }> // excerpt ≤ 200 chars
  changeSets: Array<{ id: string; status: string; summary: string | null; itemCount: number }>
  markdown: string
}
export function buildDigest(input: DigestInput): Digest
```

Markdown template (sections with zero rows are omitted entirely):

```markdown
# «title» — meeting digest
**When:** «startedAt local» → «endedAt local or “(live)”» («h:mm duration»)
**Board:** «boardName»

## Decisions
- «text»

## Action items
- [ ] «text» — @«assigneeName», due «YYYY-MM-DD» (card: «cardId»)

## Agenda («done»/«total»)
- [x] «text»

## Notes
- «text»

## Agent dispatches («n»)
- **«target»** «question» — «status»

## Proposed changes
- «summary or “(no summary)”» — «status», «n» items
```

The route (org MEMBER, works on live or ended sessions) fetches rows, calls
`buildDigest`, returns `{ digest }`.

### 3.6 UI

**HUD session page** (`src/app/(app)/hud/[id]/page.tsx`) becomes three-zone:
existing left `rail` (situation) and center `main` (console + fleet) unchanged;
new right column `meeting` (`minmax(280px, 340px)` in `hud.module.css` grid;
stacks below main under 1100px). New component
`src/app/(app)/hud/_components/MeetingPanel.tsx`:

```ts
export function MeetingPanel(props: {
  sessionId: string
  live: boolean
  boardId: string | null
  entries: Entry[]           // from GET /api/hud/[id]/entries via SWR (10s refresh)
  onMutate: () => void       // SWR mutate for the entries key
}): JSX.Element
```

Sections top-to-bottom: **agenda** (checkbox list + inline add input; check =
`PATCH { checked }`); **capture** (kind chips `action | note | decision`
defaulting to action, one text input, Enter submits, hint line
`@name due:fri · tokens parse to assignee/due`; ambiguous-assignee response
shows the candidates line under the input); **log** (notes/decisions/actions
newest-first; action rows show assignee/due chips and a `→ card` button when
`boardId && !cardId`, a card link when `cardId`). Follow `hud.module.css` +
`km-*` class conventions; all interactive elements keyboard-reachable with
visible labels/aria-labels (accessibility skill baseline).

**Wrap-up** — new `src/app/(app)/hud/_components/WrapUp.tsx`, rendered by the
session page INSTEAD of the console/fleet when `session.status === 'ended'`
(meeting panel stays visible for post-meeting card conversion; dispatch history
collapses into the wrap-up):

```ts
export function WrapUp(props: { sessionId: string }): JSX.Element
// fetches /api/hud/[id]/digest + /api/changesets?hudSessionId=<id>
```

Shows the digest stats row, action items (with remaining `→ card` buttons via
MeetingPanel data), pending proposals (each linking to `/changes/[changeSetId]`),
and a `copy digest` button (writes `digest.markdown` to clipboard,
`navigator.clipboard.writeText`, with a `copied ✓` flash). "End session" in the
header gains a one-step inline confirm (`end session` → `confirm end?`) since
it now triggers the wrap-up transition.

**Changes pages** — the review UI moves out of the HUD:
- `src/components/changes/ChangeSetReview.tsx`: the existing
  `/hud/[id]/changes/[changeSetId]/page.tsx` component, extended with: the
  server-provided `display` string as the primary line (raw JSON payload behind
  a collapsed `<details>`), a **reject selected** button (`POST
  /api/changesets/[id]/decisions` with `decision: 'rejected'`), and an
  `expired` status chip tone (neutral).
- `src/app/(app)/changes/page.tsx`: org-wide list. Status filter chips
  (`pending` default · `applied` · `rejected` · `expired` · `all`) driving
  `GET /api/changesets?status=`. Rows: summary (or `(no summary)`), origin
  HUD title → `/hud/[id]`, item count, age, status chip; row click →
  `/changes/[changeSetId]`.
- `src/app/(app)/changes/[changeSetId]/page.tsx`: renders `ChangeSetReview`.
- DELETE the old `/hud/[id]/changes/[changeSetId]` route; update the two
  in-HUD links (`DispatchCard` proposed-change link, `SituationRail` proposals
  stat becomes a `Link` to `/changes`).
- `Sidebar.tsx`: add `Changes` nav item (GitPullRequestArrow icon) between HUD
  and Helpdesk.

**Pertinent rail + deep links:**
- `GET /api/hud/[id]/pertinent` gains `dueSoon` (dueDate in `[now, now+7d)`,
  non-terminal columns, not already overdue, sorted by dueDate, cap 8) and
  `movedThisSession` (from a new structured helper in `src/lib/card-movement.ts`:
  `listMovementsSince(db, { boardId, orgId, since }): Promise<Array<{ cardId;
  cardTitle; fromColumn: string | null; toColumn: string; movedAt: Date }>>`,
  `since = session.startedAt`, cap 8, newest first). `counts` gains both.
- `SituationRail` renders the two new groups; ALL pertinent card rows now link
  to `/board/${boardId}?card=${cardId}`.
- Board page (`src/app/(app)/board/[boardId]/page.tsx`): on load, if `?card=`
  matches a card on the loaded board, `setSelectedCardId(it)`; closing the
  modal clears the param via `router.replace`. Unknown id → param ignored.

## 4. Edge Cases

1. **Session with no board:** capture/agenda/notes all work; convert-to-card
   409s with an actionable message; digest omits the board line; rail already
   handles boardless (unchanged).
2. **Ended session:** new entries/edits 409; agenda check-off and
   convert-to-card still allowed; dispatch console already disabled (existing).
3. **Parser:** `"@brad send contract due:fri"` → assignee `brad`, text
   `send contract`; `"email brad@a1.dev about due:2026-13-45 budget"` → NO
   assignee (mid-word `@`), NO due (invalid date), tokens stay in text;
   `"@brad"` alone → residual text empty → route 400s (text.min(1) after
   parse); `"due:fri due:mon call"` → first token wins, second stays in text;
   empty/whitespace raw → 400 at zod.
4. **Ambiguous assignee** (two members named Bradley/Brad): entry saved
   unassigned, response `'ambiguous'` + candidates; UI hint, chair can PATCH
   `assigneeId` from the candidates line.
5. **Convert idempotence:** double-click / retry → second call 409s (cardId
   already set, checked inside the transaction).
6. **Expiry:** set created 15 days ago `pending` → GET flips to `expired`,
   apply refuses (status no longer matches); `partially_applied` 15 days old →
   untouched. TTL env unset/garbage → default 14.
7. **Decisions:** rejecting a strict subset leaves set `pending`; rejecting the
   remainder later flips it `rejected`.
8. **Display resolver:** card deleted after proposal → display uses raw id +
   `(not found)`; malformed payload JSON → `«op» (unreadable payload)`, never a
   throw.
9. **Deep link:** `?card=` for a card on another board / deleted → ignored;
   modal close removes the param without adding history entries.
10. **Digest on a live session:** allowed (chair peeks mid-meeting);
    `endedAt: null` → duration null, markdown shows `(live)`.
11. **Agenda reorder:** PATCH position only affects `(session, kind='agenda')`
    ordering; ties broken by `createdAt`.

## 5. Acceptance Criteria

1. Given a live session on a board, POSTing an action entry
   `"@brad send contract due:fri"` returns 201 with text `send contract`,
   `assigneeId` = Brad's user id, `dueDate` = next Friday, and
   `assigneeResolution: 'resolved'`.
2. Given that entry, POST `/card` creates a card in the board's leftmost column
   titled `send contract` with that assignee/due date, links `entry.cardId`,
   and a second POST returns 409. The card is visible on the board.
3. Given a session with 2 decisions, 1 checked agenda item of 2, and 1 action
   with a card, GET `/digest` returns matching stats and markdown containing
   `## Decisions`, `## Action items`, `## Agenda (1/2)`; sections with no rows
   are absent.
4. Ending a session from the HUD shows the wrap-up: stats, pending proposals
   linking to `/changes/[id]`, and `copy digest` puts the markdown on the
   clipboard.
5. Given a pending ChangeSet created 15 days ago, GET `/api/changesets` returns
   it as `expired` and POST apply returns an error; a 15-day-old
   `partially_applied` set is returned unchanged.
6. On `/changes/[changeSetId]`, selecting all items and clicking
   `reject selected` marks every item rejected and the set status `rejected`;
   the raw payload is hidden behind a collapsed details element while a
   `Move "…" from … to …` sentence is visible.
7. `/changes` lists the org's sets filtered to `pending` by default and is
   reachable from the sidebar; the HUD proposals stat links to it.
8. The pertinent response includes `dueSoon` and `movedThisSession` per §3.6,
   and clicking any rail card opens that card's modal on the board via
   `?card=`.
9. Full verification gate green: `npx tsc --noEmit`, `npx eslint . --max-warnings 0`,
   `npx vitest run`, `npm run build`.

## 6. Architecture Decision

- **Changes, not redesign** — see header verdict.
- **One `HudEntry` table, kind-discriminated**, not four tables: entries are
  one ordered feed with one CRUD surface and a digest projection; per-kind
  nullable fields (`checkedAt`, `assigneeId`, `dueDate`, `cardId`) are cheap in
  SQLite and match the repo's string-enum style (`AgentDispatch.status`,
  `ChangeSet.status`).
- **Deterministic capture parser, no LLM**: instant, free, testable to the
  four-shape contract; an LLM adds latency and failure modes to a
  during-meeting hot path. (An LLM pass can be layered later; out of scope.)
- **Chair-direct card creation** (not a self-approved ChangeSet): the
  propose→approve invariant exists to gate *agents*; forcing the human chair
  through their own approval queue is ceremony with no trust gain. Provenance
  still lands in `AgentActivity`.
- **Lazy expiry on read**, not a cron: no new scheduled surface, idempotent,
  and correctness only matters at read/apply time anyway.
- **Computed digest**, not persisted: always consistent with current entry/
  changeset state (post-meeting card conversions update it for free); nothing
  to migrate; markdown is a pure render.
- **Review UI relocates to `/changes/[id]`** as a shared component; changesets
  outlive sessions, so their home can't be under `/hud/[id]`.
- **Files:** new code lives in `src/lib/host-hud/{capture,digest}.ts`,
  `src/lib/changesets-display.ts`, `src/app/api/hud/**/entries*`,
  `src/app/(app)/changes/**`, `src/components/changes/`, and two new HUD
  `_components`. Existing files are extended, never restructured.
