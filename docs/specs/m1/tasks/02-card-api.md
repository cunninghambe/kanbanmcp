# Task 02 — Card API: roles, parent, AI fields

**Agent type:** coder
**Depends on:** 01-schema
**Spec sections:** §4.1 (Card create / update), §7 AC-4, §6 E5/E6, §8 row 3

---

## Goal

Extend the existing card create (`POST /api/boards/[boardId]/cards`) and patch (`PATCH /api/cards/[cardId]`) endpoints to accept the new role and AI fields: `reviewerId`, `approverId`, `parentCardId`, `aiAutoReview`, `aiReviewParams`. Tighten the create endpoint to **require** `assigneeId` (AC-4). Enforce org-membership IDOR checks on all three role IDs. Enforce parent-card same-board check. Do **not** implement subtree path recompute here (Task 03 owns that) — set `path` and `depth` on **create only** using a shared helper that Task 03 will also write to. Implementation is in this one task; the helper is co-owned.

## Inputs — files to read first

- `/root/kanbanmcp/src/app/api/cards/[cardId]/route.ts` — canonical PATCH pattern (Zod validation, `resolveCard`, IDOR check on assignee, `prisma.$transaction`)
- `/root/kanbanmcp/src/app/api/boards/[boardId]/cards/route.ts` — canonical create pattern (Zod, `resolveBoard`, position computation, API-key vs cookie creator resolution)
- `/root/kanbanmcp/src/lib/api-helpers.ts` — `requireSession`, `requireOrgRole`, `apiError`
- `/root/kanbanmcp/prisma/schema.prisma` — post Task 01 (new `Card` fields available)
- M1 spec §4.1, §7 AC-4, §8 row 3 ("App-layer Zod for `assigneeId`")

## Files to create / modify

**Modify:**
- `/root/kanbanmcp/src/app/api/cards/[cardId]/route.ts` — extend PATCH schema and validation; preserve all existing logic
- `/root/kanbanmcp/src/app/api/boards/[boardId]/cards/route.ts` — make `assigneeId` required; accept new fields; compute `path` and `depth` from parent

**Create:**
- `/root/kanbanmcp/src/lib/cards.ts` — shared helpers used by this task and Task 03:
  - `computeChildPathAndDepth(parent: { id: string, path: string, depth: number }): { path: string, depth: number }`
  - `MAX_NESTING_DEPTH = 50`
  - `aiReviewParamsSchema` — exported Zod object
  - `roleMembershipCheck(prisma, userIds: string[], orgId: string): Promise<{ ok: true } | { ok: false; missingId: string }>` — used by both routes to validate `assigneeId`, `reviewerId`, `approverId` in one query

## Interface contract

### `src/lib/cards.ts`

```ts
import { z } from 'zod'
import type { PrismaClient } from '@prisma/client'

export const MAX_NESTING_DEPTH = 50

export const aiReviewParamsSchema = z.object({
  model: z.string().min(1),
  rubric: z.string().min(1),
  customInstructions: z.string().optional(),
})

export type AiReviewParams = z.infer<typeof aiReviewParamsSchema>

export function computeChildPathAndDepth(parent: {
  id: string
  path: string
  depth: number
}): { path: string; depth: number } {
  // Parent at root has path "" and depth 0 → child path "/parentId/", depth 1
  // Parent at depth 2 with path "/A/B/" → child path "/A/B/parentId/", depth 3
  return {
    path: `${parent.path}${parent.id}/`,
    depth: parent.depth + 1,
  }
}

export async function roleMembershipCheck(
  prisma: Pick<PrismaClient, 'orgMember'>,
  userIds: ReadonlyArray<string>,
  orgId: string
): Promise<{ ok: true } | { ok: false; missingId: string }>
```

Implementation note for `roleMembershipCheck`: dedupe userIds, single `findMany` with `where: { orgId, userId: { in: deduped } }`, compare returned set against deduped set, return first missing.

### Create endpoint — extended Zod schema

```ts
const createCardSchema = z.object({
  title: z.string().min(1).max(500),
  columnId: z.string().min(1),
  description: z.string().optional(),
  sprintId: z.string().optional(),
  assigneeId: z.string().min(1),                   // NOW REQUIRED — AC-4
  reviewerId: z.string().min(1).optional(),
  approverId: z.string().min(1).optional(),
  parentCardId: z.string().min(1).optional(),
  aiAutoReview: z.boolean().optional(),
  aiReviewParams: aiReviewParamsSchema.nullable().optional(),
  dueDate: z.string().datetime({ offset: true }).optional(),
  labels: z.array(z.string()).optional(),
})
```

Validation order in the route:
1. `requireSession`, `resolveBoard`, `requireOrgRole(MEMBER)` (unchanged)
2. `safeParse`. On failure return existing 400 shape `{ error: 'Validation failed', issues }`. **Override message for missing `assigneeId`** to read `"assigneeId is required"` (AC-4 requires the exact string). Easiest: check `result.error.issues` for path `['assigneeId']` with code `'invalid_type'` and return `apiError(400, 'assigneeId is required')` early. Otherwise the default `Validation failed` envelope is fine.
3. Column-belongs-to-board check (existing)
4. `roleMembershipCheck(prisma, [assigneeId, reviewerId, approverId].filter(isString), session.orgId)`. On failure: `apiError(400, '<role>Id must be a member of this organization')` — derive role name by matching `missingId`.
5. If `parentCardId` provided:
   - Fetch parent card with `select: { id: true, boardId: true, path: true, depth: true }`
   - Reject 400 "Parent card not found" if null
   - Reject 400 "Parent card must be on the same board" if `parent.boardId !== params.boardId`
   - Reject 400 "Maximum nesting depth (50) reached" if `parent.depth + 1 > MAX_NESTING_DEPTH`
   - Compute `{ path, depth } = computeChildPathAndDepth(parent)`
6. Validate `aiReviewParams` is already covered by Zod; serialise to JSON string for storage: `aiReviewParams ? JSON.stringify(aiReviewParams) : null`
7. `prisma.card.create` with all fields. Default unset booleans: `aiAutoReview` defaults to `false` via schema. Set `path` and `depth` only when parent is provided; otherwise the schema defaults (`""`, `0`) win.

### PATCH endpoint — extended Zod schema

```ts
const updateCardSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  columnId: z.string().optional(),
  position: z.number().int().min(0).optional(),
  sprintId: z.string().nullable().optional(),
  assigneeId: z.string().min(1).optional(),         // REJECT null — breaking change vs current schema
  reviewerId: z.string().min(1).nullable().optional(),
  approverId: z.string().min(1).nullable().optional(),
  aiAutoReview: z.boolean().optional(),
  aiReviewParams: aiReviewParamsSchema.nullable().optional(),
  dueDate: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(VALID_PRIORITIES).optional(),
  labels: z.array(z.string()).optional(),
  siblingPositions: z.array(...).optional(),         // unchanged
})
```

**Explicit removals from PATCH:** `assigneeId` is no longer nullable. **Explicit additions:** `reviewerId`, `approverId`, `aiAutoReview`, `aiReviewParams`. **`parentCardId` is NOT handled here** — reparenting has its own endpoint (Task 03).

After Zod validation:
- Run `roleMembershipCheck` against the union of `assigneeId`, `reviewerId`, `approverId` (only the non-null, non-undefined ones).
- Inside the existing `prisma.$transaction`, add to the scalar update payload:
  - `reviewerId` if defined (null or string)
  - `approverId` if defined (null or string)
  - `aiAutoReview` if defined
  - `aiReviewParams: aiReviewParams === undefined ? undefined : aiReviewParams === null ? null : JSON.stringify(aiReviewParams)`

### Response shape (unchanged scaffold, additional fields)

The GET-after-update `findUnique` `include` must add `reviewer`, `approver`, and basic select fields (`id, email, name`). Do NOT include `signoffs` or `artifacts` here — Tasks 04 and 06 own their own endpoints and don't need them embedded by default. Do NOT include `children` — Task 03 handles trees.

The `aiReviewParams` field returned to clients should be **parsed back to an object** at the route boundary (or returned as a string — clients then parse). Decision: **parse and return as object** to keep the API contract symmetric with the input shape. Add a helper:

```ts
function decodeAiReviewParams(raw: string | null): AiReviewParams | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const result = aiReviewParamsSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
```

Co-locate this helper in `src/lib/cards.ts` and export it. Apply in both the create and PATCH responses.

## Implementation notes

1. **AC-4 wording.** The test asserts the message string `"assigneeId is required"`. Do not return `"Validation failed"` for this specific case. See validation order step 2 above.
2. **`assigneeId` tightening is a breaking change.** Any existing client that sends `assigneeId: null` on PATCH will now get a 400. This is intentional per §8 row 3. Add a one-line code comment at the Zod definition: `// PATCH no longer accepts null — see spec §8 "App-layer Zod"`. Existing tests in `__tests__/cards-api.test.ts` that send `assigneeId: null` to PATCH must be updated (covered in Task 10 tests; in this task, fix any that newly fail by updating their fixture to a real user id).
3. **API-key auth path on create.** Preserve the existing `session.isApiKeyAuth → resolve createdById from first org admin` logic. The new fields still apply. `assigneeId` from the request is what gets stored. The API key is not the assignee.
4. **No transaction needed on create** if no children operations — keep `prisma.card.create` non-transactional like the current code. Position computation race is the same as today.
5. **PATCH transaction integrity.** Add the new scalar fields to the existing `updateData` builder inside the transaction. Do not add separate update calls.
6. **No path / depth changes on PATCH.** Reparenting goes through Task 03's `/reparent` endpoint. PATCH on a card with `parentCardId` in the body should be rejected by Zod (it is not in the schema). If a client sends it, Zod's default behaviour is to strip unknown keys — confirm that `updateCardSchema` does not use `.strict()`. It currently does not. ✓.
7. **`aiReviewParams` storage.** SQLite has no JSON type; store as TEXT. The schema column type is `String?`. JSON.stringify on write, JSON.parse on read.
8. **Self-parenting on create.** Not possible — the card doesn't exist yet. No check needed.
9. **No structural changes to existing tests.** Existing `__tests__/cards-api.test.ts` will need fixture updates to include `assigneeId` on create requests it sends; that is part of this task's "make the existing suite green" obligation.

## Acceptance criteria

- **AC-4:** `POST /api/boards/X/cards` with body missing `assigneeId` → 400 with `{ error: "assigneeId is required" }` (not the generic envelope).
- **PATCH** with `assigneeId: null` → 400.
- **PATCH** with `reviewerId: <non-org-member-id>` → 400 with message containing "must be a member of this organization".
- **POST/PATCH** with `aiReviewParams: { model: "x", rubric: "y", customInstructions: "z" }` → row stored with JSON string; response returns the parsed object.
- **POST** with `parentCardId` pointing to a card on a different board → 400 "Parent card must be on the same board".
- **POST** with `parentCardId` pointing to a card at depth 49 → child created with `depth=50, path="<parent.path>parentId/"`. Depth 50 is the cap; this case is the boundary. Depth 49 + 1 = 50 is allowed; rejection only at >50. **Re-read §6 E4 / AC-10**: "Maximum nesting depth (50) reached" implies 50 is the max allowed. Use `parent.depth + 1 > MAX_NESTING_DEPTH` as the reject condition → 51 is rejected, 50 is allowed. Document this in a comment.
- Existing tests pass after fixture updates.
- `npx tsc --noEmit` passes.

## Tests to write

Tests for this task go in:
- `/root/kanbanmcp/__tests__/api/cards-create.test.ts` — new file, covers AC-4 plus the new fields. Use the mocking pattern from existing `__tests__/cards-api.test.ts`.
- `/root/kanbanmcp/__tests__/lib/cards.test.ts` — unit tests for `computeChildPathAndDepth`, `aiReviewParamsSchema`, `roleMembershipCheck` (mock prisma), `decodeAiReviewParams`.

`cards-create.test.ts` asserts:
- Missing `assigneeId` → 400 with exact body `{ error: 'assigneeId is required' }`.
- `reviewerId` not in org → 400 with the "must be a member" message.
- `parentCardId` on different board → 400.
- `parentCardId` at depth 49 → success; created with depth 50 and correct path.
- `parentCardId` at depth 50 → 400 with "Maximum nesting depth (50) reached".
- `aiReviewParams` round-trips: input object → stored as JSON string → response parses back.

`cards.test.ts` asserts:
- `computeChildPathAndDepth({ id: 'A', path: '', depth: 0 })` → `{ path: '/A/', depth: 1 }`
- `computeChildPathAndDepth({ id: 'C', path: '/A/B/', depth: 2 })` → `{ path: '/A/B/C/', depth: 3 }`
- `aiReviewParamsSchema` rejects missing `model`, accepts `customInstructions: undefined`.
- `roleMembershipCheck` returns `{ ok: false, missingId }` for the first missing user.
- `decodeAiReviewParams` returns `null` on invalid JSON.

Mock `@/lib/db` per the existing pattern. **Do not write integration tests** — all DB calls are mocked.

## Out of scope for this task

- `/reparent`, `/promote`, `/children` endpoints (Task 03)
- Artifact upload / download (Task 04)
- AI review worker (Task 05)
- Signoff endpoints (Task 06)
- MCP tool registration (Task 07)
- Any UI (Tasks 08, 09)
- Touching `mcp-server.ts` — the existing `update_card` MCP tool already supports `assigneeId` and is not expanded in this task (covered in Task 07)

## Done when

- Both routes pass the new Zod schemas.
- `roleMembershipCheck` is called and enforced.
- `aiReviewParams` round-trips correctly.
- All new and existing tests pass.
- `npx tsc --noEmit` passes.
- Single commit on `feat/m1-review-workflow` named e.g. `feat(m1): card API accepts roles, parent, ai fields`.
