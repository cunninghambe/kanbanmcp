# Task 08 — UI: card detail panel (roles, AI toggle + params editor, artifact list, signoff buttons)

**Agent type:** designer
**Depends on:** 02-card-api, 04-artifacts, 05-ai-review-worker, 06-signoffs
**Spec sections:** §10 subtask 8

---

## Goal

Extend the existing card detail panel (wherever the current single-card view lives — see Inputs) to surface the new M1 features: reviewer/approver selectors, AI auto-review toggle with a collapsible params editor, the artifact list with upload + delete + AI-review status, and the signoff buttons (visible only to the assigned reviewer or approver). No new pages — modify the existing card panel component(s) and add new sub-components co-located with it.

## Inputs — files to read first

- `/root/kanbanmcp/src/app/` — find the file that currently renders the single-card view (likely `boards/[boardId]/page.tsx` or a co-located `card-modal.tsx`). The coder agent must locate it; do not assume. The spec does not specify file paths for UI.
- `/root/kanbanmcp/src/lib/cards.ts` — `AiReviewParams` type (Task 02)
- `/root/kanbanmcp/src/lib/storage.ts` types — for the upload form
- API endpoints from Tasks 02, 04, 05, 06 — exact request/response shapes
- M1 spec §4.1, §4.4, §4.5, §4.6 — endpoint contracts
- The user's global CLAUDE.md a11y section (WCAG 2.1 AA, semantic HTML, keyboard nav)

## Files to create / modify

**Modify:**

- The existing card detail / card modal component (locate first; commonly `src/app/.../CardModal.tsx` or similar)
- The existing data-fetching hook for a card (likely `useCard` with SWR) — extend to include the new fields and refetch points

**Create (co-located with the card panel):**

- `RoleSelector.tsx` — searchable select for org members, used for `assigneeId`/`reviewerId`/`approverId`
- `AiReviewToggle.tsx` — switch + collapsible `<details>` for the params editor (model, rubric, customInstructions)
- `ArtifactList.tsx` — upload, list, delete, status badge per AI review
- `SignoffPanel.tsx` — buttons (Approve / Request Changes / Reject) + comment field; rendered only when the current user is the card's reviewer or approver

## Interface contract

### `RoleSelector` props

```ts
interface RoleSelectorProps {
  label: 'Assignee' | 'Reviewer' | 'Approver'
  selectedUserId: string | null
  orgMembers: { id: string; name: string; email: string }[]
  required?: boolean
  onChange: (userId: string | null) => void
}
```

- Renders `<label htmlFor=...>` linked to a `<select>` (semantic). Each option `<option value={id}>{name} ({email})</option>`. Empty option only if `required !== true`.
- The selected option is keyboard-navigable.
- Visible focus indicator (Tailwind `focus:ring`).

### `AiReviewToggle` props

```ts
interface AiReviewToggleProps {
  enabled: boolean
  params: AiReviewParams | null
  onSave: (next: { enabled: boolean; params: AiReviewParams | null }) => Promise<void>
}
```

- Toggle is a real `<input type="checkbox" role="switch">` with associated `<label>`.
- When toggled to `true` AND `params` is null, the params editor expands automatically and inputs are required before saving.
- `model` is a `<select>` with a fixed set of options: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` (placeholder — read from a const in `src/lib/ai-review/models.ts`; Task 05 should expose this const).
- `rubric` is a `<textarea>` with a min-height and a maxlength of 8000.
- `customInstructions` is an optional `<textarea>` with maxlength 4000.
- Save button disabled while `onSave` is in flight; failed save surfaces the error inline.

### `ArtifactList` props

```ts
interface ArtifactListProps {
  cardId: string
  canDelete: (artifact: { uploaderId: string }) => boolean // injected by the parent (knows current user id + admin role)
}
```

- Internally fetches `GET /api/cards/[cardId]/artifacts` via SWR; revalidate every 5 s while the panel is open AND there is at least one review with status in `pending` or `running`. Otherwise revalidate on focus only.
- Renders an upload `<form encType="multipart/form-data">` with a single `<input type="file">` and a Submit button. The file input has an `accept` attribute matching the MIME allowlist (`application/pdf,text/*,image/png,image/jpeg,image/webp,application/json,application/x-yaml,text/markdown`).
- Each artifact row: filename (link to `/api/artifacts/[id]/download`), size, uploader, badge per AI review summarising status, and a delete button (shown only when `canDelete(artifact)` is true).
- Status badge text: `Pending` (grey), `Running` (yellow), `Done` (green), `Failed` (red), `Skipped` (grey-dashed). Each badge is a `<span aria-label>` for screen readers.
- Empty state: "No artifacts yet. Upload a file to attach it."
- Loading state: skeleton rows.
- Error state: "Couldn't load artifacts" + retry button.

### `SignoffPanel` props

```ts
interface SignoffPanelProps {
  cardId: string
  role: 'REVIEWER' | 'APPROVER' // determined by parent based on current user vs card.reviewerId/approverId
  onSubmitted: () => void // parent refreshes the card
}
```

- Three buttons: Approve, Request changes, Reject. Each is a real `<button>` with text + colour (green / yellow / red).
- Optional `<textarea>` for `comment`, with a 2000-char maxlength.
- On click, POSTs to `/api/cards/[cardId]/signoffs` with `{ role, decision, comment }`.
- Disables all buttons during submit.
- On success: calls `onSubmitted`. Renders a brief confirmation message (`aria-live="polite"`).
- On error: surfaces the `error` from the API response inline.

### Card panel modifications

- Add the new sections in this order, under the existing description:
  1. Roles (Assignee, Reviewer, Approver via `RoleSelector`)
  2. AI auto-review (`AiReviewToggle`)
  3. Artifacts (`ArtifactList`)
  4. Signoffs section: shows the latest reviewer + approver signoff (from `GET /api/cards/[cardId]/signoffs?latestPerRole=true`), and if the current user is the reviewer or approver, renders `SignoffPanel` for their role beneath the latest decisions.
- All section headings are real `<h3>` elements.
- Save behaviour for the role selectors: existing PATCH-on-change pattern (debounced 300 ms is fine if currently used; otherwise PATCH on blur).

## Implementation notes

1. **Accessibility (non-negotiable).**
   - All form controls have associated `<label>`.
   - Toggle uses `role="switch"` and `aria-checked`.
   - Buttons are `<button type="button">` (or `type="submit"` inside a form), never `<div role="button">`.
   - Visible focus indicators across all interactive elements.
   - Keyboard test: every action achievable via Tab + Enter / Space.
2. **No mouse-only actions.** No drag-drop UI changes in this task (out of scope).
3. **Loading / empty / error states defined for every fetcher.** This is in the project's global CLAUDE.md: "every data-fetching component must define its loading, empty, error, and success states upfront".
4. **SWR usage.** Match existing patterns. Use `swr` (already a dep). Key per resource: `["card", cardId]`, `["artifacts", cardId]`, `["signoffs", cardId]`.
5. **Org members source.** The card panel needs the list of org members for `RoleSelector`. Use the existing endpoint (find it in `src/app/api/orgs/`). If none exists, the coder must stop and ask — do not add a new endpoint in this task. (If the existing UI already lists members for the assignee, reuse that source.)
6. **Polling vs realtime.** Stick with SWR polling for review status. Realtime (the existing `realtime/` endpoint) is out of scope here; if the codebase already has a websocket bridge for cards, you may piggyback, but do not extend it.
7. **Optimistic update on toggle.** When the user flips `aiAutoReview`, optimistically update the UI; revert on error.
8. **No new design tokens.** Match the existing Tailwind config and component styling. Status badges use existing colour tokens.
9. **Empty-state copy is product-visible.** Use plain English; no engineering jargon.

## Acceptance criteria

- The card panel shows reviewer and approver selectors alongside the existing assignee.
- Changing the reviewer issues a PATCH and re-renders the card (success indicator visible briefly).
- AI auto-review toggle round-trips: flipping on → params editor expands → saving with valid params → toggle persists across refresh.
- Saving with empty `model` or `rubric` is blocked client-side and shows a Zod-style validation error.
- Uploading a PDF shows it in the list within one revalidation cycle. Status starts `Pending`, eventually `Done` (or whatever the backend reports). The badge updates without a page refresh.
- Uploading a `.zip` is blocked client-side (via `accept` attribute) AND server-side (415 surfaced as an inline error).
- The delete button is only visible to the uploader and to org admins.
- The signoff section appears only when the current user is the card's reviewer or approver.
- The reviewer sees only the REVIEWER buttons; the approver sees only the APPROVER buttons. A user who is both sees both sections labelled.
- A keyboard-only walkthrough completes every workflow (assigning roles, uploading, signing off).
- `npx tsc --noEmit` passes. ESLint passes.

## Tests to write

Component tests under `__tests__/components/` (create the directory if missing):

- `card-panel.test.tsx` — renders sections in order; calls PATCH on role change
- `role-selector.test.tsx` — keyboard navigation; required-but-empty rejected
- `ai-review-toggle.test.tsx` — toggle on → params editor expands; invalid params blocks save
- `artifact-list.test.tsx` — upload form posts multipart; status badges render per state; delete only visible to uploader/admin
- `signoff-panel.test.tsx` — only renders when current user is the card's reviewer or approver; POSTs to /signoffs

Stack:

- `@testing-library/react` — **not yet in `package.json`**; add as a dev dep in this task (`@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`). Pin exact versions. Update `vitest.config.ts` to add `environment: 'jsdom'` for component tests (or use the multi-environment config). The coder must justify bundle impact in the PR description (testing-library is dev-only, no runtime cost).
- Query by accessible role / label, not by CSS class. Per global CLAUDE.md.

## Out of scope for this task

- Sub-card tree view (Task 09)
- New backend endpoints — UI consumes only what Tasks 02/04/05/06 expose
- Real-time websocket updates
- Drag-drop reordering of artifacts or roles
- Permission editor / role assignment outside the card panel
- Mobile-specific styling (responsive is required for AA, but no dedicated mobile redesign)

## Done when

- All four new components exist and pass their tests.
- Card panel renders the new sections in the documented order.
- A keyboard-only flow passes manual QA.
- `npx tsc --noEmit` and ESLint pass.
- Single commit on `feat/m1-review-workflow`.
