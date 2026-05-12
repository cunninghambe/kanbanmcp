# Task 03 — Tree endpoints: children, reparent, promote, path recompute helper

**Agent type:** coder
**Depends on:** 01-schema, 02-card-api
**Spec sections:** §4.2 (children), §4.3 (promote), §6 E1/E2/E3/E4, §7 AC-8/AC-9/AC-10, §8 row 1 (adjacency + materialised path)

---

## Goal

Implement the three card-tree endpoints — `GET /api/cards/[cardId]/children`, `POST /api/cards/[cardId]/promote`, `POST /api/cards/[cardId]/reparent` — and the shared path/depth recompute helper they all depend on. The helper must atomically rewrite `path` and `depth` for a subtree in a single SQLite transaction. Also harden card deletion so that when a parent is deleted, surviving children get their paths/depths recomputed (turning into top-level cards). This task contains every "tree mutation" code path in M1.

## Inputs — files to read first

- `/root/kanbanmcp/src/app/api/cards/[cardId]/route.ts` — auth pattern, `resolveCard`, DELETE
- `/root/kanbanmcp/src/lib/cards.ts` — produced by Task 02; exports `computeChildPathAndDepth`, `MAX_NESTING_DEPTH`
- `/root/kanbanmcp/src/lib/api-helpers.ts` — `requireSession`, `requireOrgRole`, `apiError`
- M1 spec §4.2, §4.3, §6 E1/E2/E3/E4, §7 AC-8/AC-9/AC-10, §8 row 1
- **Audit assumption 3 — resolved:** path recompute is **eager**, not lazy. E1's "lazy cleanup job" wording is overridden: when a parent is deleted, its surviving children's `parentCardId` is `SetNull` AND their subtree paths are recomputed eagerly in the DELETE route's transaction.

## Files to create / modify

**Create:**
- `/root/kanbanmcp/src/lib/tree.ts` — pure functions for subtree recompute (no Prisma client construction inside; receives `tx` as a parameter)
- `/root/kanbanmcp/src/app/api/cards/[cardId]/children/route.ts` — GET handler
- `/root/kanbanmcp/src/app/api/cards/[cardId]/promote/route.ts` — POST handler
- `/root/kanbanmcp/src/app/api/cards/[cardId]/reparent/route.ts` — POST handler

**Modify:**
- `/root/kanbanmcp/src/app/api/cards/[cardId]/route.ts` — extend DELETE to recompute subtree paths for orphaned children inside a transaction

## Interface contract

### `src/lib/tree.ts`

```ts
import type { Prisma, PrismaClient } from '@prisma/client'

type Tx = Prisma.TransactionClient

// Re-export from cards.ts for convenience — do not redefine
export { computeChildPathAndDepth, MAX_NESTING_DEPTH } from './cards'

/**
 * Recompute path + depth for `cardId` and every descendant.
 * - If `newParentId` is null, the card becomes top-level: path = "", depth = 0.
 *   Otherwise: path = parent.path + parent.id + "/", depth = parent.depth + 1.
 * - All descendants are rewritten by string-replacing the old subtree prefix
 *   with the new subtree prefix.
 *
 * Must be called inside a transaction. Caller is responsible for cycle and
 * depth checks BEFORE calling this — this function does no validation.
 *
 * Returns the number of rows updated (the card + descendants).
 */
export async function recomputeSubtreePathAndDepth(
  tx: Tx,
  cardId: string,
  newParentId: string | null
): Promise<{ updatedCount: number }>

/**
 * Walk from `candidateAncestorId` up via `parentCardId` until null, looking
 * for `cardId`. Returns true if a cycle would be introduced by reparenting
 * `cardId` to be a child of `candidateAncestorId`.
 *
 * Hard-stops after MAX_NESTING_DEPTH iterations as a safety net against
 * pre-existing corrupt data.
 */
export async function wouldFormCycle(
  tx: Tx,
  cardId: string,
  candidateAncestorId: string
): Promise<boolean>

/**
 * Fetch the full subtree rooted at `rootId` up to `maxDepth` extra levels.
 * Uses `path LIKE root.path || root.id || '/%'` for the subtree scan.
 *
 * The returned tree is depth-first by `path`, then `position` within siblings.
 * Each node carries `assignee`, `reviewer`, `approver`, `aiAutoReview`, and
 * `signoffs[latest per role]`.
 *
 * `maxDepth` is the maximum number of additional levels below `rootId` to
 * return (0 = just the root, 1 = root + immediate children, etc.).
 */
export async function fetchSubtree(
  prisma: PrismaClient,
  rootId: string,
  maxDepth: number
): Promise<SubtreeNode[]>

export interface SubtreeNode {
  id: string
  title: string
  description: string | null
  parentCardId: string | null
  path: string
  depth: number
  aiAutoReview: boolean
  assigneeId: string | null
  reviewerId: string | null
  approverId: string | null
  assignee: { id: string; email: string; name: string } | null
  reviewer: { id: string; email: string; name: string } | null
  approver: { id: string; email: string; name: string } | null
  signoffs: {
    reviewer: SignoffSummary | null
    approver: SignoffSummary | null
  }
  // additional fields preserved from the Card model as needed by the UI
}

interface SignoffSummary {
  id: string
  decision: string  // APPROVED|REJECTED|REQUESTED_CHANGES
  createdAt: Date
  user: { id: string; name: string; email: string }
}
```

### Endpoint: `GET /api/cards/[cardId]/children?depth=N`

- Auth: `requireSession`, `resolveCard`, `requireOrgRole(MEMBER)` — same pattern as existing GET. Sub-card auth inherits from board-level membership (audit assumption 1).
- Parse `depth` from `req.nextUrl.searchParams`. Default = 1. **Cap at 5** (spec §4.2 "default 1, max 5 to bound payload"). Values <1 → 1. Values >5 → 5. Non-numeric → 1.
- Returns `{ root: SubtreeNode, descendants: SubtreeNode[] }` — root included so the client always knows the parent. Both arrays use `SubtreeNode` shape (root has its own row separated for clarity).
- Empty subtree → `{ root: <the card>, descendants: [] }`.
- Status 200 on success, 404 if card not found (resolveCard), 403 if org mismatch.

### Endpoint: `POST /api/cards/[cardId]/promote`

- Auth: same.
- Body: empty (or ignored).
- Behaviour: sets `parentCardId = null` for the card AND recomputes path/depth for the card and all descendants in one transaction.
- If the card is already a root (`parentCardId === null`) → return 200 with `{ card }`, no-op.
- Returns `{ card: <the updated card> }`, status 200.

### Endpoint: `POST /api/cards/[cardId]/reparent`

- Auth: same.
- Body Zod schema:
  ```ts
  const reparentSchema = z.object({
    parentCardId: z.string().nullable(),  // null = promote to root (equivalent to /promote)
  })
  ```
- Validation (all inside a `prisma.$transaction` to make checks consistent):
  1. If `parentCardId === null` → behave as promote (skip the cycle/depth checks).
  2. Reject self-parenting (`parentCardId === cardId`) → 400 "Cannot reparent a card to itself".
  3. Fetch the new parent: must exist, must be on the same board → 400 otherwise.
  4. Cycle check: `wouldFormCycle(tx, cardId, parentCardId)` → 400 "Cycle detected" (AC-9).
  5. Depth check: if `newParent.depth + 1 + subtreeMaxDepth > MAX_NESTING_DEPTH` → 400 "Maximum nesting depth (50) reached" (AC-10). `subtreeMaxDepth` = max depth of any descendant minus card's current depth (i.e., the height of the subtree below the moving card). Compute via `SELECT MAX(depth) FROM cards WHERE path LIKE ?`.
  6. Update the card's `parentCardId`.
  7. Call `recomputeSubtreePathAndDepth(tx, cardId, parentCardId)`.
- Returns `{ card }`.

### Card DELETE — modification

Replace the current single `prisma.card.delete` with:

```ts
await prisma.$transaction(async (tx) => {
  // Find direct children before delete (they'll have parentCardId SetNull by Prisma)
  const children = await tx.card.findMany({
    where: { parentCardId: params.cardId },
    select: { id: true },
  })

  await tx.card.delete({ where: { id: params.cardId } })

  // Children's parentCardId is now null due to onDelete: SetNull, but their
  // path/depth still reflect the old hierarchy. Recompute each subtree to
  // be a top-level subtree.
  for (const child of children) {
    await recomputeSubtreePathAndDepth(tx, child.id, null)
  }
})
```

This makes deletion eager (audit assumption 3).

## Implementation notes

1. **Subtree query.** Use `path LIKE ?` with parameter `${root.path}${root.id}/%` to fetch all descendants. SQLite `LIKE` uses `%` and `_`. Card IDs are cuids (lowercased base36) — they never contain `%` or `_`, so escaping is unnecessary. Add a comment noting this assumption.
2. **String-replace for subtree recompute.**
   ```ts
   const oldSubtreePrefix = `${card.path}${card.id}/`
   const newCardPath = newParentId === null
     ? ''
     : `${newParent.path}${newParent.id}/`
   const newSubtreePrefix = `${newCardPath}${card.id}/`
   const depthDelta = (newParent ? newParent.depth + 1 : 0) - card.depth

   // Update root card
   await tx.card.update({
     where: { id: cardId },
     data: { path: newCardPath, depth: card.depth + depthDelta },
   })

   // Update descendants in one statement using SQLite's REPLACE() function
   await tx.$executeRaw`
     UPDATE cards
     SET path = REPLACE(path, ${oldSubtreePrefix}, ${newSubtreePrefix}),
         depth = depth + ${depthDelta}
     WHERE path LIKE ${oldSubtreePrefix + '%'}
   `
   ```
   SQLite's `REPLACE(haystack, needle, repl)` is safe; since `oldSubtreePrefix` always ends in `/` and the paths it appears in always start with the prefix, there is no risk of mid-string replacement. **Test this assumption** with the cards.test fixture before merge.
3. **`wouldFormCycle` algorithm.**
   ```ts
   let cursor: string | null = candidateAncestorId
   for (let i = 0; i < MAX_NESTING_DEPTH + 1; i++) {
     if (cursor === null) return false
     if (cursor === cardId) return true
     const row = await tx.card.findUnique({
       where: { id: cursor },
       select: { parentCardId: true },
     })
     if (!row) return false
     cursor = row.parentCardId
   }
   return true  // safety stop: assume cycle if we exceed depth cap
   ```
4. **Reparent inside a single transaction.** All reads and writes go through `tx`, not `prisma`. SQLite uses `BEGIN IMMEDIATE` under Prisma's transaction wrapper, serialising writes.
5. **`fetchSubtree` shape — signoffs latest-per-role.** Two strategies; pick (B):
   - (A) For each card, run two `findFirst` queries. O(2N) queries. Reject — too chatty.
   - (B) Bulk-fetch all signoffs for the subtree's card IDs in one query (`where: { cardId: { in: ids } }, orderBy: { createdAt: 'desc' }`), then group in-process and keep the first signoff seen per `(cardId, role)`. O(1) extra query. ✓
6. **`fetchSubtree` ordering.** `ORDER BY path ASC, position ASC`. Path is lexicographic but since cuid is order-irrelevant, you must also sort by `position` within siblings. The test should assert ordering explicitly.
7. **`promote` is sugar over reparent.** Internally call `reparent` logic with `parentCardId: null`. Implement once.
8. **DELETE transaction.** Wrap the existing delete in a transaction (keeping the existing 404/403 checks outside). The existing route currently does `prisma.card.delete({ where: { id: params.cardId } })` non-transactionally; this is the change point.
9. **No special handling needed for `Comment`, `Artifact`, `Signoff` records of deleted cards** — `onDelete: Cascade` handles them. Children survive (`SetNull`) but their subordinate artifacts/signoffs travel with them.
10. **Subtree depth check on reparent.** A 10-deep subtree moved under a depth-45 parent would make leaves at depth 56 — must reject. Hence the `newParent.depth + 1 + subtreeMaxDepth > 50` check using SQL `MAX(depth)`.

## Acceptance criteria

- **AC-8:** `GET /api/cards/X/children?depth=3` returns the subtree to 3 levels deep. Each card includes `assignee`, `reviewer`, `approver`, `aiAutoReview`, and `signoffs.{reviewer, approver}` (latest per role). Cards beyond depth 3 are not included.
- **AC-8 boundary:** `depth=0` returns root only; `depth=999` clamped to 5; `depth=-1` clamped to 1.
- **AC-9:** Reparenting card A under one of its own descendants returns 400 with `{ error: "Cycle detected" }`.
- **AC-10:** Reparenting a card whose subtree height + new parent depth > 50 returns 400 with `{ error: "Maximum nesting depth (50) reached" }`.
- **AC-9 self-parent:** Reparenting `A` to `A` returns 400 "Cannot reparent a card to itself".
- **Reparent atomicity:** if the recompute fails mid-flight, the transaction rolls back and no path/depth values are partially updated.
- **Promote:** `POST /cards/X/promote` on a non-root card sets `parentCardId=null` and recomputes the subtree.
- **DELETE cascade:** Deleting a parent card with two children — the children become roots (`parentCardId=null`, `path=""`, `depth=0`); grandchildren attached to those children also have their paths/depths rewritten.
- `npx tsc --noEmit` passes; existing tests still pass.

## Tests to write

- `/root/kanbanmcp/__tests__/lib/tree.test.ts`
  - `computeChildPathAndDepth` (re-export check)
  - `wouldFormCycle`: builds an A→B→C chain via mocked prisma; asserts true for cycle, false for unrelated parent.
  - `recomputeSubtreePathAndDepth`: with a mocked tx that records calls, asserts the correct `update` + `$executeRaw` parameters.
- `/root/kanbanmcp/__tests__/api/cards-children.test.ts` — AC-8
  - `depth` clamping
  - signoffs latest-per-role
  - subtree LIKE query (mock `prisma.card.findMany` and assert the `where` clause)
- `/root/kanbanmcp/__tests__/api/cards-reparent.test.ts` — AC-9, AC-10
  - cycle: A→B→A → 400 "Cycle detected"
  - depth: subtree height 10 onto parent at depth 45 → 400
  - different-board parent → 400
  - happy path: response is the updated card; tx is invoked
- `/root/kanbanmcp/__tests__/api/cards-promote.test.ts`
  - non-root card → 200, parent null, path empty, depth 0
  - already-root card → 200 no-op
- `/root/kanbanmcp/__tests__/api/cards-delete-with-children.test.ts`
  - delete parent → children's paths/depths updated to root (mock prisma transaction)

Mock prisma per the existing pattern. Do not write any tests that require a real DB.

## Out of scope for this task

- `aiReviewParams` inheritance walker (Task 05)
- Artifact endpoints (Task 04)
- AI review worker (Task 05)
- Signoff endpoints (Task 06)
- MCP tools (`list_card_tree`, etc — Task 07)
- UI (Tasks 08, 09)
- Any pagination on `/children` — the depth cap of 5 is the bound

## Done when

- All three endpoints exist and behave per the contract.
- `src/lib/tree.ts` exports the documented surface.
- DELETE recomputes children eagerly.
- All new and existing tests pass.
- `npx tsc --noEmit` passes.
- Single commit on `feat/m1-review-workflow`.
