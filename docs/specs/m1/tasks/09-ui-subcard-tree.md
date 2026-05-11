# Task 09 — UI: sub-card tree (nested view, collapse past depth 3, promote action)

**Agent type:** designer
**Depends on:** 03-tree-endpoints, 08-ui-card-panel
**Spec sections:** §10 subtask 9, §4.2, §4.3

---

## Goal

Add a sub-card tree section to the card detail panel that lists children fetched from `GET /api/cards/[cardId]/children`. Depth 1–3 is expanded by default; depth 4 and beyond is collapsed (lazy-fetched on expand). Each row shows the card title, assignee, reviewer / approver chips, and latest signoff badges. Each non-root row has an inline "Promote to top-level" action that calls `POST /api/cards/[cardId]/promote`.

## Inputs — files to read first

- `/root/kanbanmcp/src/lib/tree.ts` — `SubtreeNode` shape (Task 03)
- The card panel modified in Task 08 — for the integration point
- M1 spec §4.2, §4.3 — endpoint contracts
- Global CLAUDE.md a11y rules

## Files to create / modify

**Create (co-located with the card panel):**
- `SubcardTree.tsx` — the recursive renderer
- `SubcardRow.tsx` — single row (extracted for clarity)
- `useSubcardTree.ts` — SWR hook for the tree

**Modify:**
- The card panel from Task 08 — add `<SubcardTree cardId={cardId} />` as a new section beneath Signoffs

## Interface contract

### `useSubcardTree(cardId, depth)`

```ts
function useSubcardTree(cardId: string, depth: number): {
  data: { root: SubtreeNode; descendants: SubtreeNode[] } | undefined
  isLoading: boolean
  error: Error | undefined
  refresh: () => Promise<void>
}
```

Default `depth = 3`. The hook fetches `/api/cards/[cardId]/children?depth=3`. When a user expands a node at depth 3, the SubcardTree component issues a sub-fetch with `depth=3` rooted at that node and **merges** the results into the existing tree (do not refetch from the original root — wastes bandwidth).

### `SubcardTree` props

```ts
interface SubcardTreeProps {
  cardId: string  // the root of the tree this component renders
}
```

- Renders the heading "Sub-cards" (`<h3>`).
- Empty state: "No sub-cards yet." with a brief description.
- If `error`: "Couldn't load sub-cards" + retry button.
- Loading state: skeleton with 3 rows.
- Successful state: renders descendants grouped by parent via the materialised path. Use an unordered list (`<ul>`) with nested `<ul>` for children. Each list item is a `<SubcardRow>`.

### `SubcardRow` props

```ts
interface SubcardRowProps {
  node: SubtreeNode
  hasChildren: boolean
  isExpanded: boolean
  isLoading: boolean      // when this row's children are mid-fetch
  onToggleExpand: () => void
  onPromote: () => Promise<void>
  depth: number           // relative depth from the root of this tree (root = 0)
}
```

- Row layout: an indent proportional to `depth`, a disclosure chevron (only when `hasChildren`), the title (as a link to that card's panel — clicking it opens the sub-card), the assignee avatar/name, reviewer + approver chips (small), signoff badges (REVIEWER, APPROVER if present), and a "•••" menu containing "Promote to top-level".
- Chevron is a `<button aria-expanded>` with the chevron as a child element; do NOT make the chevron a `<div>`.
- When `depth >= 3` and `hasChildren && !isExpanded`, show a "+N more" disclosure label so the user knows there's more.
- Promote action: confirmation dialog ("Promote 'Title' to a top-level card? This will move it out of its parent.") then call `POST /api/cards/[node.id]/promote`. On success, call `refresh()` from the hook so the tree re-renders.

## Implementation notes

1. **Path-based grouping.** Descendants come back as a flat list; group them into a tree using `parentCardId`. Build a `Map<parentId, SubtreeNode[]>` once, then render recursively.
2. **Depth collapse.** "Collapse past depth 3" means: a row at depth ≤ 2 (relative to the panel's root card) is always expanded; a row at depth ≥ 3 starts collapsed. The user can expand any collapsed row to lazy-fetch its descendants.
3. **Stable keys.** Use `node.id` as the React key.
4. **Disclosure semantics.** Use `aria-expanded` on the toggle button and `aria-controls` referencing the child list's `id`.
5. **Optimistic delete-from-tree on promote.** Promoting a card removes it from this subtree (it becomes top-level). After the POST succeeds, the local cache can be updated optimistically or simply re-fetched via `refresh()`.
6. **No drag-drop reparenting.** Out of scope. A future task can add `POST /api/cards/[cardId]/reparent` as a drag-and-drop target.
7. **No deep-link to a sub-card panel.** Clicking the title opens the sub-card in the panel (replacing the current view) — the existing card-modal navigation pattern. Do not add new routes.
8. **Performance — typical subtree size.** Spec depth cap is 50 but UI bound is depth 3 by default; "no virtualization needed under 100 items" (global CLAUDE.md). If the depth-3 fetch returns more than ~80 nodes, group sibling lists into a "Show 50 more" expander. Otherwise render all.

## Acceptance criteria

- The Sub-cards section appears beneath Signoffs on the card panel.
- Children at depth 1 and 2 are visible by default; depth 3 is visible; depth ≥4 is hidden behind an expander showing "Expand sub-tree".
- Clicking a sub-card row title opens that card in the panel.
- Clicking "Promote to top-level" on a child shows a confirm dialog; confirming issues the POST and removes the card from the visible tree.
- An empty subtree shows the documented empty state.
- A keyboard-only walk traverses the tree, expands rows, and triggers promote.
- `npx tsc --noEmit` passes; ESLint passes; component tests pass.

## Tests to write

- `/root/kanbanmcp/__tests__/components/subcard-tree.test.tsx`
  - Renders flat-to-tree grouping correctly
  - Depth ≥3 rows start collapsed; expanding them issues a fetch
  - Promote confirmation dialog appears; confirming calls promote endpoint and refreshes
  - Keyboard: Tab + Enter on chevron toggles expansion
  - Empty state renders when descendants is empty

Mock SWR fetcher and the promote POST per existing test patterns.

## Out of scope for this task

- Reparent via drag-drop
- Sub-card creation UI (covered by the card panel's existing create card flow — or add a small "+ Add sub-card" button calling the existing POST endpoint with `parentCardId` if cheap; if not cheap, defer)
- Webhook / realtime updates of the tree
- Tree filtering or search

## Done when

- The Sub-cards section renders correctly with documented states.
- Keyboard-only walk passes.
- All tests pass; `npx tsc --noEmit` and ESLint pass.
- Single commit on `feat/m1-review-workflow`.
