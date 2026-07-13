# Propose-time org-scope validation for ChangeSet items

Date: 2026-07-13 · Branch: `fix/mcp-propose-validation`

## Problem

ChangeSet proposals are agent-submitted. The MCP `propose_changeset` handler
(`toolProposeChangeset`) and the HUD dispatch worker (`maybeCreateChangeSet`)
both org-validate only the **top-level** `boardId`. Per-item payloads pass
`changeItemInputSchema`, which validates **shape only**. So an org-X-scoped key
can embed org-Y ids (`cardId`, `columnId`, `boardId`, `targetCardId`) inside
item payloads and they are persisted into org X's ChangeSet store. Apply
(`applyItem`) and display (`describeChangeItems`) are already org-scoped, so the
foreign ids are inert downstream — but they should never enter the store in the
first place. This closes the gap at PROPOSE time.

## Decision

Add one shared, side-effect-free async helper
`validateChangeItemsOrgScope(db, orgId, items)` in `src/lib/changesets.ts`.
Each caller applies its own failure semantics (they differ intentionally):

- **MCP handler** — reject the whole proposal. Any invalid item throws
  `{ code: -32602, message }` (matches the existing propose_changeset input /
  board-not-found conventions). Nothing is created. An explicit agent action is
  all-or-nothing so the agent gets told exactly what to fix and resubmits.
- **Worker** — drop invalid items, keep the valid subset (identical to its
  existing "drop schema-invalid items rather than fail the answer" stance). If
  nothing valid remains, no ChangeSet is created (`return null`).

Validation lives in the helper, NOT inside `createPendingChangeSet`, precisely
because the two callers need reject-all vs drop-invalid. Top-level `boardId`
validation stays where it already is in each caller; the helper only covers
per-item payload ids.

## Contract

```ts
export type ChangeItemInput = z.infer<typeof changeItemInputSchema>

export interface ChangeItemOrgScopeResult {
  validItems: ChangeItemInput[]                       // input order preserved
  invalid: Array<{ index: number; reason: string }>   // index into input array
}

export async function validateChangeItemsOrgScope(
  db: PrismaClient,
  orgId: string,
  items: ChangeItemInput[]
): Promise<ChangeItemOrgScopeResult>
```

**Referenced ids per op** (every one must resolve inside `orgId`; all are
persisted, so all are checked). Card/Column scope via `board: { orgId }`, Board
via `orgId` — the batched pattern established in `changesets-display.ts`:

| op            | Card refs                       | Column ref  | Board ref |
|---------------|---------------------------------|-------------|-----------|
| create_card   | `targetCardId?`                 | `columnId`  | `boardId` |
| move_card     | `cardId`, `targetCardId?`       | `columnId`  | —         |
| update_card   | `cardId`, `targetCardId?`       | —           | —         |
| comment_card  | `cardId`, `targetCardId?`       | —           | —         |

(The move payload's destination column field is `columnId`, not `toColumnId`.)

**Batching:** three `findMany`s max — one per entity type, ids de-duped across
all items via `Set`. No N+1. Present-sets are built once, then each item is
checked against them in memory.

## Edge cases

- **Cross-org id in any position** → item invalid → MCP throws / worker drops.
- **Nonexistent id** → indistinguishable from foreign by design (absent from the
  org present-set); same handling. Reason text says "not found or not in org".
- **`targetCardId` foreign while payload `cardId` valid** → invalid
  (`targetCardId` is persisted on the ChangeItem row).
- **Mixed valid/invalid items** → MCP rejects the whole proposal; worker keeps
  the valid subset only.
- **Shape-unparseable payload** (should not occur — callers pre-validate with
  `changeItemInputSchema`; defensive only) → treated as invalid.
- **Duplicate ids across items** → de-duped in the query; each item still judged
  independently.
- **Empty referenced-id set** → impossible (every op references ≥1 id).

## Acceptance criteria

- Given a move_card item whose `cardId` is a real card in another org, when
  proposed via MCP, the handler throws `-32602` and `changeSet.create` is never
  called.
- Given the same item via the worker, `maybeCreateChangeSet` drops it; if it was
  the only item, no ChangeSet is created.
- Given all in-org ids, both callers create the ChangeSet with items unchanged.
- Given a mixed set via the worker, only the in-org items reach
  `createPendingChangeSet`.
- No change to `applyChangeSet` / `describeChangeItems` behavior.
