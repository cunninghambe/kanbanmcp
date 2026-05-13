# M1 — Review Workflow, Sub-Issues, and Opt-In AI Artifact Review

**Status:** Draft for review
**Scope:** `Card` model only (not `Ticket`)
**Excludes:** Google Docs / Sheets / Slides integration — that is M2

---

## 1. Problem Statement

KanbanMCP cards today are flat and assignee-only. Teams coordinating real work need to express **who reviews** and **who approves** an item separately from who does it, and to break large items into nested sub-tasks of arbitrary depth. They also want a per-card switch that lets Claude auto-review uploaded artifacts (PDFs, markdown, images, code) against criteria the card author provides, so the human reviewer arrives with a pre-baked critique instead of starting cold.

## 2. Boundaries

**In scope (M1):**

- Required `assigneeId`, optional `reviewerId`, optional `approverId` on every card.
- Unlimited nesting of sub-cards under a parent card. Schema unlimited; UI collapses past depth 3.
- Per-card `aiAutoReview` toggle (default false). When on, any uploaded artifact is queued for Claude review.
- Per-card `aiReviewParams` JSON: `{ model, rubric, customInstructions }`. If null on a child card, inherit from nearest ancestor with non-null params.
- Advisory `Signoff` records — reviewer / approver can record APPROVED / REJECTED / REQUESTED_CHANGES. No hard column gate.
- Artifact uploads (multipart, stored locally or to S3-compatible bucket). MIME allowlist.
- AiReview pipeline: artifact uploaded → job enqueued → Claude called → result stored → comment posted by AI Reviewer service user.

**Out of scope (M1):**

- Google Drive integration (Docs / Sheets / Slides) — full spec in `m2-google-artifacts.md`.
- Hard gating of column transitions on signoff status.
- Bulk re-review of historical artifacts.
- Ticket-side workflow extensions.
- Reviewer / approver suggestion ML.
- Webhook payload changes (deferred to M3).

**External dependencies added:**

- `@anthropic-ai/sdk` for Claude calls.
- `pdf-parse` (or equivalent ~20 KB gzipped) for PDF text extraction.
- Storage: local disk under `./uploads/` for dev; `S3_BUCKET` env-driven swap for prod (use `@aws-sdk/client-s3` only if `STORAGE_DRIVER=s3`).

## 3. Schema Changes (Prisma)

```prisma
model Card {
  // existing fields unchanged
  assigneeId       String?         // remains nullable in DB; required at API layer (Zod). SQLite ALTER COLUMN avoided. See §7.
  reviewerId       String?
  approverId       String?

  parentCardId     String?
  path             String          @default("")  // materialised ancestor path: "/grandparentId/parentId/" — empty for root
  depth            Int             @default(0)

  aiAutoReview     Boolean         @default(false)
  aiReviewParams   String?         // JSON string (SQLite — no native JSON). Schema: { model: string, rubric: string, customInstructions: string }

  reviewer         User?           @relation("CardReviewer", fields: [reviewerId], references: [id])
  approver         User?           @relation("CardApprover", fields: [approverId], references: [id])
  parent           Card?           @relation("CardChildren", fields: [parentCardId], references: [id], onDelete: SetNull)
  children         Card[]          @relation("CardChildren")
  artifacts        Artifact[]
  signoffs         Signoff[]

  @@index([parentCardId])
  @@index([path])
}

model Artifact {
  id            String   @id @default(cuid())
  cardId        String
  uploaderId    String
  filename      String
  mimeType      String
  sizeBytes     Int
  storageKey    String   // local path or S3 key — never the public URL
  source        String   @default("UPLOAD") // "UPLOAD" in M1; reserved values for M2: "GOOGLE_DOC" | "GOOGLE_SHEET" | "GOOGLE_SLIDE" | "URL"
  createdAt     DateTime @default(now())

  card          Card     @relation(fields: [cardId], references: [id], onDelete: Cascade)
  uploader      User     @relation(fields: [uploaderId], references: [id])
  reviews       AiReview[]

  @@index([cardId])
}

model AiReview {
  id              String    @id @default(cuid())
  artifactId      String
  status          String    @default("pending") // pending | running | done | failed | skipped
  model           String    // e.g. "claude-opus-4-7"
  rubricSnapshot  String    // verbatim rubric used (so changes to card don't invalidate history)
  instructions    String?   // customInstructions at time of run
  output          String?   // markdown of the review
  errorMessage    String?
  inputTokens     Int?
  outputTokens    Int?
  startedAt       DateTime?
  finishedAt      DateTime?
  createdAt       DateTime  @default(now())

  artifact        Artifact  @relation(fields: [artifactId], references: [id], onDelete: Cascade)

  @@index([artifactId])
  @@index([status])
}

model Signoff {
  id          String   @id @default(cuid())
  cardId      String
  userId      String
  role        String   // "REVIEWER" | "APPROVER"
  decision    String   // "APPROVED" | "REJECTED" | "REQUESTED_CHANGES"
  comment     String?
  createdAt   DateTime @default(now())

  card        Card     @relation(fields: [cardId], references: [id], onDelete: Cascade)
  user        User     @relation(fields: [userId], references: [id])

  @@index([cardId])
}
```

**User model additions:**

```prisma
model User {
  // existing
  reviewedCards     Card[]       @relation("CardReviewer")
  approvedCards     Card[]       @relation("CardApprover")
  uploadedArtifacts Artifact[]
  signoffs          Signoff[]
}
```

## 4. Interface Contracts

### 4.1 Card create / update (existing routes)

`POST /api/boards/[boardId]/cards` and `PATCH /api/cards/[cardId]` accept:

```ts
{
  title: string,                       // existing
  description?: string,
  assigneeId: string,                  // NEW: required on create; required on PATCH if set to null is rejected
  reviewerId?: string | null,
  approverId?: string | null,
  parentCardId?: string | null,        // null = top-level
  aiAutoReview?: boolean,
  aiReviewParams?: { model: string, rubric: string, customInstructions?: string } | null,
  // existing fields below
  columnId, sprintId, dueDate, priority, labels, position, siblingPositions
}
```

All three role IDs (`assigneeId`, `reviewerId`, `approverId`) must be org members — same IDOR check as existing `assigneeId`. `parentCardId` if provided must be a card on the same board.

### 4.2 List children

`GET /api/cards/[cardId]/children?depth=2` — returns the subtree rooted at `cardId`, up to `depth` levels (default 1, max 5 to bound payload). Uses `path LIKE '<parent.path><parent.id>/%'` for fast subtree fetch.

### 4.3 Promote sub-card to top-level

`POST /api/cards/[cardId]/promote` — sets `parentCardId = null`, recomputes `path` and `depth` for the card and all descendants. Wrapped in a transaction.

### 4.4 Artifacts

```
POST   /api/cards/[cardId]/artifacts            multipart/form-data, field "file"
GET    /api/cards/[cardId]/artifacts            list artifacts for card
GET    /api/artifacts/[artifactId]/download     stream the file
DELETE /api/artifacts/[artifactId]              only uploader or org admin
```

Response shape:

```ts
{ artifact: { id, filename, mimeType, sizeBytes, source, createdAt,
              uploader: { id, name, email },
              reviews: AiReview[] } }
```

MIME allowlist (M1): `application/pdf`, `text/*`, `image/png`, `image/jpeg`, `image/webp`, `application/json`, `application/x-yaml`, `text/markdown`. Reject otherwise. Max size: 25 MB.

### 4.5 AI Reviews

```
GET    /api/artifacts/[artifactId]/reviews      list AiReview records for an artifact
POST   /api/artifacts/[artifactId]/reviews      manually trigger a re-review (uses current card aiReviewParams)
GET    /api/reviews/[reviewId]                  get one review
```

Auto-trigger: when `POST /api/cards/[cardId]/artifacts` succeeds AND `card.aiAutoReview === true`, enqueue an `AiReview` row with `status = "pending"` and kick the worker.

### 4.6 Signoffs

```
POST /api/cards/[cardId]/signoffs
  body: { role: "REVIEWER" | "APPROVER", decision: "APPROVED" | "REJECTED" | "REQUESTED_CHANGES", comment?: string }
GET  /api/cards/[cardId]/signoffs
```

Auth: only the card's `reviewerId` may submit `role=REVIEWER`; only `approverId` may submit `role=APPROVER`. A user may submit multiple signoffs over time — UI shows the latest per role.

### 4.7 MCP tool additions

Add to `/api/mcp` JSON-RPC manifest:

- `create_subcard` — params `{ parentCardId, title, description?, assigneeId, ... }`
- `set_card_reviewers` — params `{ cardId, reviewerId?, approverId? }`
- `toggle_ai_review` — params `{ cardId, enabled, params? }`
- `list_card_tree` — params `{ cardId, depth }`
- `record_signoff` — params `{ cardId, role, decision, comment? }`
- `list_artifacts` — params `{ cardId }`

## 5. AI Review Pipeline

```
Upload → POST /api/cards/X/artifacts
   ↓
Card.aiAutoReview = true? ──no──→ stop (artifact stored, no review)
   ↓ yes
Resolve effective aiReviewParams:
  walk parentCardId chain until a card has non-null aiReviewParams,
  or fall back to org default (env: AI_REVIEW_DEFAULT_RUBRIC)
   ↓
Create AiReview row, status=pending
   ↓
Enqueue job (in-process queue for M1 — simple async worker, single concurrency)
   ↓
Worker:
  - Fetch artifact bytes
  - Extract text: PDF → pdf-parse; images → describe via Claude vision; text/* → utf-8
  - Build prompt: system = rubric + customInstructions; user = "Review this artifact: <text>"
  - Call Claude (model from params)
  - On success: status=done, output=markdown, token counts saved
  - On error: status=failed, errorMessage saved
   ↓
On status=done, post a Comment on the card from the "AI Reviewer" service user
  body = "**AI review of <filename>:**\n\n" + output
```

**Service user:** seeded at migration time as a User with `isAgent=true`, email `ai-reviewer@kanbanmcp.local`, name `AI Reviewer`. Its id is stored in env `AI_REVIEWER_USER_ID` to avoid lookup.

**Queue:** in-process for M1. A `BullMQ`-style upgrade is M3 if throughput demands it.

## 6. Edge Cases

| #   | Scenario                                                               | Behaviour                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Parent card deleted while child exists                                 | `onDelete: SetNull` on `parentCardId` — children become top-level. `path` and `depth` are recomputed lazily by a cleanup job; until then queries by path return the orphan with its old path. |
| E2  | Card moved to a different parent                                       | API endpoint `POST /api/cards/[cardId]/reparent` updates the card and recomputes `path` and `depth` for the whole subtree in one transaction.                                                 |
| E3  | Cycle attempted (card becomes its own ancestor)                        | Reject with 400 in reparent endpoint: walk up new parent's chain, fail if `cardId` appears.                                                                                                   |
| E4  | Depth exceeds 50                                                       | Hard cap. Reject card create / reparent with 400. Prevents runaway recursion.                                                                                                                 |
| E5  | Assignee removed from org                                              | Card retains `assigneeId` but `assignee` join returns null. UI shows "(former member)". No automatic reassignment.                                                                            |
| E6  | Reviewer attempts to signoff on a card where they are not the reviewer | 403.                                                                                                                                                                                          |
| E7  | `aiAutoReview` toggled on after artifacts already uploaded             | No auto-review of historical artifacts. User can `POST /api/artifacts/[id]/reviews` manually to trigger.                                                                                      |
| E8  | `aiReviewParams` is null on card AND every ancestor                    | Use env default `AI_REVIEW_DEFAULT_RUBRIC`. If env unset, mark AiReview as `failed` with errorMessage "No review params configured".                                                          |
| E9  | AI call fails (rate limit / network)                                   | Up to 3 retries with exponential backoff (1s, 4s, 16s). After retries: status=failed. No automatic re-queue.                                                                                  |
| E10 | Artifact MIME not in allowlist                                         | 415 Unsupported Media Type at upload.                                                                                                                                                         |
| E11 | Artifact > 25 MB                                                       | 413 Payload Too Large.                                                                                                                                                                        |
| E12 | PDF extraction yields empty text                                       | Skip text-based review; if image-rich, send first page as image to Claude vision. If both fail: status=skipped, errorMessage="No extractable content".                                        |
| E13 | Multiple concurrent uploads on same card                               | Each gets its own AiReview row, queued in upload order. No deduplication.                                                                                                                     |
| E14 | User deletes the artifact mid-review                                   | Worker checks artifact still exists before posting comment. If deleted: AiReview row remains with status=done but no comment posted.                                                          |
| E15 | Signoff submitted on a card with no reviewer/approver assigned         | 400 — "No reviewer assigned" / "No approver assigned".                                                                                                                                        |
| E16 | Inheritance with intermediate null                                     | Card C has null params, parent B has null params, grandparent A has params. C uses A's.                                                                                                       |

## 7. Acceptance Criteria

**Schema and migrations:**

- AC-1: `prisma migrate dev` succeeds against a fresh SQLite DB with all new tables and indices.
- AC-2: Backfill migration script sets `Card.assigneeId = Card.createdById` for any row where `assigneeId IS NULL`. After backfill, **app-layer** Zod schema rejects `assigneeId: null` on update. DB column remains nullable for SQLite practicality. Documented in schema comment.
- AC-3: Migration seeds the AI Reviewer service user idempotently. Its id is logged for the `.env`.

**API behaviour:**

- AC-4: `POST /api/boards/X/cards` without `assigneeId` returns 400 with message "assigneeId is required".
- AC-5: `POST /api/cards/X/artifacts` with allowed MIME stores the file under `<STORAGE_DIR>/<artifactId>` (local) or S3, returns 201 with artifact body.
- AC-6: When `aiAutoReview=true`, uploading an artifact creates an AiReview with status=pending within 100 ms of upload response. Worker picks it up within 500 ms. After Claude returns (mocked in tests), status=done and a comment is posted on the card from the AI Reviewer user.
- AC-7: `POST /api/cards/X/signoffs` from a user who is neither reviewer nor approver returns 403.
- AC-8: `GET /api/cards/X/children?depth=3` returns the subtree, with each card including its `assignee`, `reviewer`, `approver`, `aiAutoReview`, and `signoffs[latest per role]`.
- AC-9: Reparenting a card to one of its own descendants returns 400 "Cycle detected".
- AC-10: Depth-50 limit: creating a card with a parent already at depth 49 returns 400 "Maximum nesting depth (50) reached".

**Inheritance:**

- AC-11: Card with null `aiReviewParams` and parent with `{ model: "claude-sonnet-4-6", rubric: "..." }` resolves to parent's params at upload time.
- AC-12: Inheritance walks up to 50 levels max (matches depth cap).

**MCP tools:**

- AC-13: `POST /api/mcp` with `method: "create_subcard"` and a valid `parentCardId` creates a card with correct `parentCardId`, `path`, and `depth`.
- AC-14: `list_card_tree` returns the same shape as `GET /api/cards/X/children`.

## 8. Architecture Decisions

| Decision                                        | Choice                                              | Rationale                                                                                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------- |
| Tree storage                                    | Adjacency list (`parentCardId`) + materialised path | Recursive CTEs are slow on SQLite. Path is cheap to query (`LIKE path                                                                                                                                      |     | '%'`) and updates only require a subtree-scoped recompute. |
| Depth cap                                       | 50                                                  | Prevents runaway recursion without practically limiting users.                                                                                                                                             |
| `assigneeId` constraint location                | App-layer (Zod)                                     | SQLite `ALTER COLUMN` requires table rebuild via Prisma shadow migration. The app-layer enforcement is sufficient because no other code path can write to `Card.assigneeId`. Documented in schema comment. |
| Queue                                           | In-process worker, concurrency=1                    | M1 load is low. Avoids the BullMQ+Redis dependency. Upgrade path is documented.                                                                                                                            |
| AI Reviewer identity                            | Seeded User with `isAgent=true`                     | Reuses existing `Comment.user` join. No new "system commenter" concept needed.                                                                                                                             |
| `aiReviewParams` as JSON string                 | Yes (SQLite limitation)                             | Parse and validate with Zod at API and at worker boundary.                                                                                                                                                 |
| Storage                                         | Local disk in dev; S3 swap in prod via env          | Same approach as existing repo conventions (no S3 client unless configured).                                                                                                                               |
| Artifact `source` enum value space              | Includes M2 values as reserved strings now          | Avoids a schema migration when M2 ships; M1 API rejects anything but `UPLOAD`.                                                                                                                             |
| Migration of existing assigneeId-nullable cards | Backfill to `createdById`                           | Most defensible default — the creator is the only known principal.                                                                                                                                         |

## 9. Test Plan Summary

Tests live under `__tests__/` mirroring the existing structure.

- `__tests__/api/cards-create.test.ts` — AC-4, role-membership IDOR
- `__tests__/api/cards-children.test.ts` — AC-8, path queries, depth bounding
- `__tests__/api/cards-reparent.test.ts` — AC-9, AC-10, subtree recompute
- `__tests__/api/artifacts-upload.test.ts` — AC-5, MIME allowlist, size cap
- `__tests__/api/ai-review-pipeline.test.ts` — AC-6, mocked Claude SDK, status transitions, comment posted
- `__tests__/api/signoffs.test.ts` — AC-7, latest-per-role query
- `__tests__/lib/inheritance.test.ts` — AC-11, AC-12, AC-16, env fallback
- `__tests__/mcp/tools.test.ts` — AC-13, AC-14

Claude SDK is mocked via Vitest `vi.mock('@anthropic-ai/sdk', ...)` returning deterministic outputs keyed off the rubric. No real network calls in CI.

## 10. Subtask Breakdown (for architect to refine)

1. **Schema + migration** — add fields, indices, run prisma migrate, write backfill script, seed AI Reviewer user. (Coder.)
2. **Card API extensions** — extend Zod schemas, update create/PATCH routes for roles, parent, ai fields. Validate org-membership for reviewer/approver. (Coder.)
3. **Tree endpoints** — `/children`, `/promote`, `/reparent`, path recompute helper in `lib/tree.ts`. (Coder.)
4. **Artifacts API + storage abstraction** — `lib/storage.ts` with local + S3 drivers. Upload route, download stream, delete. (Coder.)
5. **AI review worker** — `lib/ai-review/` module: queue, prompt builder, Claude client, content extractors (pdf-parse, vision). (Coder + Reviewer.)
6. **Signoffs API.** (Coder.)
7. **MCP tool registration.** (Coder.)
8. **UI: card panel** — role selectors, AI toggle + params editor, artifact list, signoff buttons. (Designer.)
9. **UI: sub-card tree** — nested view, collapse past depth 3, promote action. (Designer.)
10. **Tests** — per §9. (QA writes first per project workflow, coder makes them pass.)

Each subtask is independently verifiable. Recommended commit / PR granularity: one per subtask.

## 11. Open Questions

- Do we need an "assigned-to-me" notification feed in M1, or punt to M3?
- Should AI review be runnable on the **description** alone (no artifact), e.g. "review this spec text"? Currently no — only artifacts. Add later if asked.
- Org-level vs. board-level default rubric? Currently env-level. Board-level is small extra work if wanted.
