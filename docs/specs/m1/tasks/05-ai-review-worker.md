# Task 05 — AI review worker: queue, prompt builder, Claude client, content extractors

**Agent type:** coder
**Depends on:** 01-schema, 02-card-api, 04-artifacts
**Spec sections:** §5 (AI Review Pipeline), §7 AC-6, AC-11, AC-12, §6 E7/E8/E9/E12/E13/E14, §8 row 4 (in-process queue)

---

## Goal

Replace the no-op `enqueueAiReview` stub from Task 04 with a real in-process worker that: resolves effective `aiReviewParams` by walking the parent chain (with env fallback), creates an `AiReview` row, extracts artifact content (PDF text via `pdf-parse`, text/* via UTF-8, images via Claude vision base64), calls Claude via `@anthropic-ai/sdk`, retries up to 3 times on transient errors, persists output/tokens/status, and on success posts a `Comment` on the card from the AI Reviewer service user. Also expose a manual re-trigger endpoint and a list endpoint.

## Inputs — files to read first

- `/root/kanbanmcp/src/lib/ai-review/queue.ts` — stub from Task 04, you are replacing the implementation
- `/root/kanbanmcp/src/lib/cards.ts` — `aiReviewParamsSchema`, `MAX_NESTING_DEPTH` (Task 02)
- `/root/kanbanmcp/src/lib/storage.ts` — Task 04, for fetching artifact bytes
- `/root/kanbanmcp/prisma/seed-ai-reviewer.ts` — `AI_REVIEWER_EMAIL`, `ensureAiReviewerUser` (Task 01)
- `/root/kanbanmcp/src/lib/api-helpers.ts`
- M1 spec §5, §6 E7/E8/E9/E12/E13/E14, §7 AC-6/AC-11/AC-12
- **Audit assumption 5:** worker boot scans `pending`/`running` rows and re-enqueues; `running` rows are reset to `pending` first.
- **Audit assumption 10:** image artifacts >5 MB → `skipped`.

## Files to create / modify

**Create:**
- `/root/kanbanmcp/src/lib/ai-review/inheritance.ts` — resolves effective `aiReviewParams` by walking parent chain
- `/root/kanbanmcp/src/lib/ai-review/extractors.ts` — content extractors per MIME class
- `/root/kanbanmcp/src/lib/ai-review/claude-client.ts` — thin wrapper around `@anthropic-ai/sdk` with retry + token capture
- `/root/kanbanmcp/src/lib/ai-review/worker.ts` — single-concurrency in-process queue; exports `enqueueAiReview`, `flushForTests`, `bootstrapWorker`
- `/root/kanbanmcp/src/lib/ai-review/index.ts` — barrel for the queue's public API
- `/root/kanbanmcp/src/app/api/artifacts/[artifactId]/reviews/route.ts` — GET (list reviews for artifact), POST (manual trigger)
- `/root/kanbanmcp/src/app/api/reviews/[reviewId]/route.ts` — GET (single review)

**Modify:**
- `/root/kanbanmcp/src/lib/ai-review/queue.ts` (existing stub from Task 04) — re-export from `worker.ts` so external import paths stay stable
- `/root/kanbanmcp/package.json` — add `@anthropic-ai/sdk` and `pdf-parse` as dependencies (do NOT run `npm install` in CI; the coder agent should add them and trust the lockfile update). Pin exact versions; record bundle impact in the PR description.

## Interface contract

### `src/lib/ai-review/inheritance.ts`

```ts
import type { PrismaClient } from '@prisma/client'
import type { AiReviewParams } from '../cards'

/**
 * Walk from `cardId` up via parentCardId, returning the first non-null parsed
 * aiReviewParams. Falls back to env AI_REVIEW_DEFAULT_RUBRIC + default model
 * if every ancestor is null. Returns null only if there is no env fallback.
 *
 * Hard-stops after MAX_NESTING_DEPTH iterations as defence against corrupt
 * parent chains.
 */
export async function resolveEffectiveAiReviewParams(
  prisma: PrismaClient,
  cardId: string
): Promise<AiReviewParams | null>

/** Env-derived default when no ancestor has params. */
export function envDefaultParams(): AiReviewParams | null
// Reads AI_REVIEW_DEFAULT_RUBRIC and AI_REVIEW_DEFAULT_MODEL.
// Returns null when AI_REVIEW_DEFAULT_RUBRIC is missing/empty.
// Default model when env unset: 'claude-opus-4-7'.
```

### `src/lib/ai-review/extractors.ts`

```ts
export interface ExtractedContent {
  kind: 'text' | 'image' | 'empty'
  text?: string            // when kind === 'text'
  imageBase64?: string     // when kind === 'image'
  imageMimeType?: string   // when kind === 'image'
}

export async function extractContent(
  bytes: Buffer,
  mimeType: string,
  filename: string
): Promise<ExtractedContent>

// Behaviour:
// - mime in text/*, application/json, application/x-yaml, text/markdown:
//   utf-8 decode → { kind: 'text', text }
// - application/pdf: run pdf-parse; if extracted text is non-empty → { kind: 'text', text };
//   if empty → { kind: 'empty' } (caller marks skipped)
// - image/png, image/jpeg, image/webp: if bytes.length <= 5 MB →
//   { kind: 'image', imageBase64: bytes.toString('base64'), imageMimeType: mime };
//   if larger → { kind: 'empty' }
// - anything else: { kind: 'empty' } (defensive — upload route already gates)
```

### `src/lib/ai-review/claude-client.ts`

```ts
import type { ExtractedContent } from './extractors'
import type { AiReviewParams } from '../cards'

export interface ClaudeReviewResult {
  output: string           // markdown
  inputTokens: number
  outputTokens: number
}

/**
 * Call Claude with the rubric + customInstructions as system, and the artifact
 * content as user message. Handles vision (image content) vs text uniformly.
 *
 * Retries up to 3 times with exponential backoff (1s, 4s, 16s) for transient
 * errors: 429, 5xx, network. Permanent errors (400, 401, 403) throw immediately.
 *
 * Throws on permanent failure or exhausted retries. The caller is responsible
 * for marking the AiReview row failed.
 */
export async function runClaudeReview(
  params: AiReviewParams,
  content: ExtractedContent,
  filename: string
): Promise<ClaudeReviewResult>
```

Prompt template (system):
```
{rubric}

{customInstructions ?? ''}
```

User message:
- For `text`: a single text block: `"Review this artifact (filename: <filename>):\n\n<text>"`
- For `image`: an image block (base64 + media type) followed by a text block: `"Review this artifact (filename: <filename>)."`

### `src/lib/ai-review/worker.ts`

```ts
/** Single-concurrency in-process queue. Pushes jobs onto an internal array;
 *  a single async worker drains. Idempotent enqueue (dedupes by artifactId). */
export async function enqueueAiReview(artifactId: string): Promise<void>

/** For tests: returns a promise that resolves when the queue is empty. */
export async function flushForTests(): Promise<void>

/** Called at app boot. Scans the DB for AiReview rows in {'pending','running'},
 *  resets 'running' to 'pending', and enqueues each. Idempotent — calling
 *  multiple times is safe. */
export async function bootstrapWorker(): Promise<void>

/** For tests: swap the Claude client with a stub. */
export function __setClaudeClientForTests(
  fn: ((params: AiReviewParams, content: ExtractedContent, filename: string) => Promise<ClaudeReviewResult>) | null
): void
```

Worker steps per job:
1. `tx.aiReview.findFirst` for the latest pending row for `artifactId`. (Multiple uploads on same artifact reuse — but in the spec each upload makes its own row; this worker is keyed on `artifactId` AND needs the AiReview row ID. **Revise:** `enqueueAiReview` takes the `aiReviewId`, not `artifactId`, OR creates the row itself. Decision: create the row inside the upload handler in Task 04 — wait, Task 04 only calls `enqueueAiReview(artifactId)`. **Resolution:** `enqueueAiReview(artifactId)` creates a fresh `AiReview` row with status `pending` and the effective params snapshot, then queues the row ID. This keeps Task 04's interface stable.

   So `enqueueAiReview(artifactId)` internally:
   - Fetches artifact + card
   - Resolves params via `resolveEffectiveAiReviewParams(card.id)`
   - If null → creates an AiReview with `status='failed'`, `errorMessage='No review params configured'` (per E8) and returns
   - Otherwise creates the AiReview row (`status='pending'`, `model=params.model`, `rubricSnapshot=params.rubric`, `instructions=params.customInstructions ?? null`) and pushes the row id onto the internal queue
2. Worker draining loop pops one job at a time:
   - `update AiReview { status: 'running', startedAt: now }`
   - Fetch artifact again, check it still exists. If deleted → finish with `status='done'` per E14 wording? **Refine:** E14 says "Worker checks artifact still exists **before posting comment**". So the worker only short-circuits the comment step on missing artifact. But if the artifact is missing here at the start, we have nothing to review. → `status='skipped'`, `errorMessage='Artifact deleted before review'`. Document this divergence in a code comment.
   - Read bytes via `storage.getStream` → buffer; pass to `extractContent`
   - If `ExtractedContent.kind === 'empty'` → `status='skipped'`, `errorMessage='No extractable content'`
   - Call `runClaudeReview(params, content, filename)`. On throw → `status='failed'`, `errorMessage=<message>`. (Retries are inside `runClaudeReview`; an exception from it means retries exhausted.)
   - On success → `status='done'`, `output, inputTokens, outputTokens, finishedAt: now`
   - **Post comment:** re-check artifact exists; if yes, look up AI Reviewer user (cached by email lookup at module load), then `prisma.comment.create({ data: { cardId: artifact.cardId, userId: aiReviewer.id, agentId: null, content: '**AI review of '+filename+':**\n\n'+output } })`. Per E14: if artifact missing at this point, skip the comment but keep `status='done'`.
3. Catch-all: any unhandled exception in the worker loop is logged but does not crash the worker. Worker remains active.

### Routes

`GET /api/artifacts/[artifactId]/reviews`:
- Auth: resolve artifact → its card → its board → orgId vs session.orgId.
- Returns `{ reviews: AiReviewResponse[] }` ordered `createdAt DESC`.

`POST /api/artifacts/[artifactId]/reviews`:
- Auth same. Body empty.
- Calls `enqueueAiReview(artifactId)` regardless of `card.aiAutoReview` (manual override per §4.5).
- Returns 202 with `{ review: <newly created AiReview> }`.

`GET /api/reviews/[reviewId]`:
- Auth same path (via artifact → card → board → orgId).
- Returns `{ review: AiReviewResponse }`.

### Response shape

```ts
interface AiReviewResponse {
  id: string
  artifactId: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  model: string
  rubricSnapshot: string
  instructions: string | null
  output: string | null
  errorMessage: string | null
  inputTokens: number | null
  outputTokens: number | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}
```

## Implementation notes

1. **Single-concurrency queue.** Pattern: a `Promise<void>` "tail" variable. `enqueueAiReview` does `tail = tail.then(() => processJob(id))`. Errors inside `processJob` are caught and logged so they don't poison the chain.
2. **Idempotent enqueue.** A `Set<string>` of in-flight review IDs. `enqueueAiReview` early-returns if the artifact already has a pending review row that is queued. Otherwise create a new row and queue it. Multiple uploads of the same artifact in M1 produce multiple Artifact rows (different IDs) — so this is really only protecting against a double-enqueue of the same row.
3. **`bootstrapWorker` invocation.** Where to call it? Next 14 has no built-in app-init hook. Two options:
   - Lazy: a module-load side effect inside `worker.ts` runs `bootstrapWorker()` once. Risk: it runs in every Next process (dev + prod build steps). Guard with `if (process.env.NEXT_PHASE !== 'phase-production-build')`.
   - Explicit: a small file `src/app/instrumentation.ts` (Next 14 supports `register()`) calls `bootstrapWorker()` once on server start.
   **Choose: instrumentation.ts.** Cleaner, only runs on real server.
4. **Claude SDK.** Use `@anthropic-ai/sdk`'s `messages.create`. Read `ANTHROPIC_API_KEY` from env. If missing at the time of a real call (not at module load), throw a permanent error → row marked `failed` with `errorMessage='ANTHROPIC_API_KEY not configured'`. Do NOT throw at module load — the worker should boot even without the key, so tests don't need it.
5. **Mocking in tests.** Vitest `vi.mock('@anthropic-ai/sdk', ...)` returning a deterministic shape. The `__setClaudeClientForTests` export is a belt-and-braces alternative for tests that want to override the function directly.
6. **Token counts.** Captured from `response.usage.input_tokens` and `response.usage.output_tokens` (Anthropic SDK).
7. **`pdf-parse` quirks.** It expects a `Buffer`. Set `verbosity: 0` to silence its console output. Catches: it crashes on encrypted PDFs — wrap in try/catch and treat thrown errors as `kind: 'empty'`.
8. **Comment author.** The AI Reviewer user's id is resolved once at module load via `prisma.user.findUnique({ where: { email: AI_REVIEWER_EMAIL } })`. Cached. If missing at runtime, fall back to `ensureAiReviewerUser(prisma)` to create it (defence against deployments that forgot to seed). Log on miss.
9. **AC-6 wording.** Spec says "AiReview created within 100 ms of upload response" and "worker picks it up within 500 ms". Test these by mocking timers and using `flushForTests()`. **Do not** assert wall-clock times in CI — assert state transitions deterministically. See "Tests to write".
10. **Inheritance walks up to 50.** AC-12 — `MAX_NESTING_DEPTH` is the hard cap. The walker iterates at most `MAX_NESTING_DEPTH` times.
11. **Manual re-trigger on a card with no aiAutoReview.** Permitted per §4.5. The worker uses `resolveEffectiveAiReviewParams`; if the chain is null and env unset, the new row is created with status `failed` and `errorMessage='No review params configured'` (per E8).
12. **E13 — multiple concurrent uploads.** Each upload creates its own Artifact, its own AiReview, its own queued job. Single-concurrency worker processes them in order.

## Acceptance criteria

- **AC-6:** Uploading an artifact to a card with `aiAutoReview=true` (mocked Claude SDK) results in:
  1. An `AiReview` row created synchronously during the upload response (status `pending`)
  2. Worker transitions row through `running` → `done`
  3. A `Comment` is created on the card with `userId === AI Reviewer user.id` and `content` starting with `"**AI review of "`
  - Test asserts these state transitions deterministically via `flushForTests()`.
- **AC-11:** Card with null `aiReviewParams` and parent with `{ model: 'claude-sonnet-4-6', rubric: 'X' }` resolves to parent's params; the resulting `AiReview.rubricSnapshot === 'X'` and `model === 'claude-sonnet-4-6'`.
- **AC-12:** Walker terminates at 50 ancestors even on a corrupt cycle (defensive).
- **E7:** Toggling `aiAutoReview` on AFTER uploads does not auto-review historical artifacts (no new rows created). Manual `POST /api/artifacts/X/reviews` creates one.
- **E8:** No ancestor has params and env unset → AiReview created with `status='failed'`, `errorMessage='No review params configured'`. No Claude call made.
- **E9:** Claude SDK rate-limit error → 3 retries with 1s/4s/16s backoff. After retries: `status='failed'`, `errorMessage` contains the error message.
- **E12:** PDF with empty extraction → `status='skipped'`, `errorMessage='No extractable content'`.
- **E13:** Two uploads on the same card produce two AiReview rows, processed in order.
- **E14:** Artifact deleted between job pop and comment post → AiReview stays at `status='done'` but no Comment is posted.
- `npx tsc --noEmit` passes; `npm test` passes.

## Tests to write

- `/root/kanbanmcp/__tests__/lib/inheritance.test.ts` — AC-11, AC-12 (and the E16 chain-with-intermediate-null case from §9; spec's "AC-16" reference is reinterpreted as E16)
  - Mock prisma chain; assert correct param resolution
  - Walker terminates at 50 even with cycle in mocked data
- `/root/kanbanmcp/__tests__/lib/extractors.test.ts`
  - text/* → text
  - application/pdf with embedded text → text (mock pdf-parse)
  - application/pdf empty → empty
  - image/png ≤5 MB → image base64
  - image/png >5 MB → empty
- `/root/kanbanmcp/__tests__/lib/claude-client.test.ts`
  - Happy path with mocked SDK
  - 429 retry: succeed on second attempt, observe backoff (use `vi.useFakeTimers()`)
  - 429 retry exhausted: throws after 3 attempts
  - 401 → throws immediately (no retry)
- `/root/kanbanmcp/__tests__/api/ai-review-pipeline.test.ts` — AC-6, E7, E8, E13, E14
  - End-to-end: mock SDK + storage + prisma; upload → flushForTests → assert comment posted
  - E7: enable aiAutoReview after upload, list artifact reviews, expect empty
  - E8: no params anywhere → status=failed
  - E13: two enqueues, both reach `done`
  - E14: simulate artifact deletion between enqueue and comment post via mock; expect `done` and no comment
- `/root/kanbanmcp/__tests__/api/reviews-routes.test.ts`
  - Manual trigger creates a pending row, returns 202
  - GET /reviews list ordering
  - GET /reviews/[id] returns single row
  - Auth: cross-org access → 403

Use `vi.mock('@anthropic-ai/sdk', ...)` and `vi.mock('@/lib/storage', ...)`. No real network. No real disk except in `storage.test.ts` (Task 04).

## Out of scope for this task

- Replacing the in-process queue with BullMQ (M3)
- Streaming the artifact bytes (we buffer; 25 MB cap is small enough)
- Real-time UI updates (the UI polls — Task 08)
- MCP tools (`toggle_ai_review`, Task 07)
- Cost dashboard / token aggregation (M3)
- Re-review on edit of `aiReviewParams` (manual trigger only)
- Org-level / board-level default rubric (env-level only — see spec Open Question)

## Done when

- Real worker replaces the Task 04 stub.
- All routes exist and pass tests.
- `instrumentation.ts` boots the worker (`bootstrapWorker()` invoked once).
- `pdf-parse` and `@anthropic-ai/sdk` added to dependencies with pinned versions; bundle impact noted in PR description.
- All new and existing tests pass; SDK mocked in CI.
- `npx tsc --noEmit` passes.
- Single commit on `feat/m1-review-workflow`.
