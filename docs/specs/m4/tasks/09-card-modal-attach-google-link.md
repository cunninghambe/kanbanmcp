# Task 09 — Card UI: extend `CardModal.tsx` with "Attach Google link" input

**Agent type:** coder
**Depends on:** 06-card-attach
**Spec sections:** M4 spec — "Card UI" block

---

## Goal

Add a "Attach Google link" affordance to the card detail modal next to the existing upload control. On submit, POST `/api/cards/[cardId]/artifacts/google`, surface inline errors with the spec-defined messages, and let the new artifact(s) appear in the existing `ArtifactList` via SWR revalidation.

## Inputs — files to read first

- `/opt/kanban/src/components/board/CardModal.tsx` — the existing modal; locate the upload affordance and the artifacts section (line ~1067 `aria-labelledby="artifacts-heading"`)
- `/opt/kanban/src/components/board/ArtifactList.tsx` — the list this attaches into; the SWR key is `['artifacts', cardId]` per line ~202 of CardModal
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — Card UI block

## Files to create / modify

**Create:**

- `/opt/kanban/src/components/board/AttachGoogleLink.tsx` — `'use client'`; small focused component (input + submit button + error display)
- `/opt/kanban/__tests__/ui/AttachGoogleLink.test.tsx`

**Modify:**

- `/opt/kanban/src/components/board/CardModal.tsx` — import + render `<AttachGoogleLink cardId={cardId} onAttached={() => mutate(['artifacts', cardId])} />` immediately below the existing upload control inside the artifacts section
- `/opt/kanban/src/components/board/ArtifactList.tsx` — if there is no Google-source icon yet, add one (small icon next to filename for `source !== 'UPLOAD'`). One-liner; do not refactor the list

## Interface contract

### `AttachGoogleLink`

```tsx
interface Props {
  cardId: string
  onAttached: () => void  // caller invalidates the SWR cache
}

// Internal state machine:
type Status =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'error'; message: string; code?: string }
  | { phase: 'partial'; message: string; rejected: Array<{ id: string; name?: string; reason: string }> }
  | { phase: 'success' }
```

Behaviour:

- Text input with `placeholder="https://docs.google.com/document/d/..."`
- Submit button "Attach" (or Enter in the input)
- On submit: POST `/api/cards/${cardId}/artifacts/google` with JSON body `{ url }`
- Response handling:
  - **201:** `success` state for ~2s, clear input, call `onAttached()`. If response includes `expandedArtifacts`, show inline summary `"Attached folder + N files"`.
  - **400 INVALID_URL:** error "That doesn't look like a Drive URL." Focus stays on the input.
  - **401 NOT_CONNECTED:** error "Connect Google in Settings to attach Drive content." Render a link `<a href="/settings/integrations">Connect Google</a>` inline.
  - **403 FORBIDDEN:** error "You don't have access to that file in Google." Include the file id from the spec wording (Card UI block: "On 403 / 404: inline error with the Google file id"). The route returns no id today (Task 06's response body for 403 is `{ error: 'FORBIDDEN' }`). **Resolution:** Task 06's route enhancement — append `?: { fileId: string }` to the 403/404 response body. Coder must add this in CardModal task and update the route response shape in coordination. Add a one-line change to `/opt/kanban/src/app/api/cards/[cardId]/artifacts/google/route.ts` to include `fileId: parsed.id` in the 403/404 body. Update Task 06's tests to assert this field. (Document this minor cross-task amendment in the PR description.)
  - **404 TRASHED / NOT_FOUND:** error with file id, similar to 403
  - **409 UNSUPPORTED_TYPE:** error "That file type isn't supported (Docs, Sheets, Slides, folders only)."
  - **422 PARTIAL_FOLDER:** success-ish state. Show `"Attached N files"` summary + a collapsible list of `rejected[]` with their reasons (TOO_MANY_FILES, TOO_LARGE, etc.). Call `onAttached()` so the list refreshes.
  - **502 / other 5xx:** error "Google was unreachable. Try again in a moment."

Accessibility:

- Input has an associated `<label>` (`htmlFor`/`id`)
- Errors rendered with `role="alert"` and `aria-live="assertive"`
- Submit button disabled during `submitting`
- After `success`, focus moves back to the input (so a user can paste another link)

### ArtifactList icon (one-liner addition)

In the row render, next to the existing mime icon, when `artifact.source !== 'UPLOAD'`:
- Render a small Google "G" icon (use Lucide `Cloud` or a SVG inline — no new dep)
- `aria-label="Google ${artifact.source.toLowerCase().replace('google_', '')}"`

## Hard rules

1. **One component, ≤180 lines.** No internal sub-components unless they cross 50 lines themselves.
2. **No new state library.** Component-local `useState`. The list refresh happens via SWR `mutate` invoked by `onAttached`.
3. **Validate URL on the client only loosely** (`url.trim().length > 0` + starts with `http`). Server is the source of truth on URL validity. Do not duplicate `parseDriveUrl` here.
4. **Paste-to-submit:** if the user pastes into the input and the value parses as a Drive URL (loose check: contains `drive.google.com` or `docs.google.com`), auto-submit. Optional UX nicety per spec wording "On paste/submit".
5. **No `any`.** Body type for the POST defined locally; response type a discriminated union per the route's status codes.
6. **No emojis** in UI strings or comments.
7. CardModal change must be the minimum necessary — one import + one component mount + (if needed) one prop wiring. Do not refactor the artifacts section.
8. The cross-task amendment to Task 06's route (adding `fileId` to 403/404 body) MUST be included in this PR with a clear note in the commit message: "Amends m4-06 route to include fileId in 403/404 body."

## Tests to write

`/opt/kanban/__tests__/ui/AttachGoogleLink.test.tsx` — RTL + stubbed `fetch`.

- **Idle render:** input + Attach button present and enabled.
- **Submit happy path:** stub POST → 201; expect input cleared, `onAttached` called once, success message shown briefly.
- **Folder happy path (201 + expandedArtifacts):** message includes "+ 3 files".
- **400 INVALID_URL:** error displayed; input preserved.
- **401 NOT_CONNECTED:** error includes "Connect Google" link to `/settings/integrations`.
- **403 FORBIDDEN with fileId:** error renders the file id.
- **404 TRASHED with fileId:** ditto.
- **409 UNSUPPORTED_TYPE:** error displayed with the spec wording.
- **422 PARTIAL_FOLDER:** rejected list renders; collapsing/expanding the list works.
- **Submitting state:** button disabled while in-flight; re-enables after response.
- **A11y:** input has a label; error role="alert"; focus returns to input after success.
- **Paste-to-submit:** simulate paste of a Drive URL; assert auto-submit.

## Verification gate (all must pass)

- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run __tests__/ui/AttachGoogleLink.test.tsx`
- Full suite: `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — full or partial

- **AC-7** (Folder expansion UI: response surfaced) — full responsibility for UI; data layer in Task 06
- **AC-8** (Folder cap UI: rejected list visible) — full responsibility for UI
- **AC-9 / AC-10** (TRASHED / FORBIDDEN inline error) — full responsibility for UI

## Out of scope

- A separate "Browse Drive" picker (out of M4)
- Per-attachment review-now buttons (existing UI handles this)
- Drag-drop of Drive URLs (text input only)

## Done when

- AttachGoogleLink renders in CardModal under the upload control.
- All states tested and pass.
- ArtifactList shows a small Google icon next to non-UPLOAD artifacts.
- Cross-task amendment to Task 06's route applied + tested.
- Single commit on `feat/m4-09-card-ui`.

## Escalate if

- The CardModal artifacts section has been restructured since Task 06 and the mount point is ambiguous — flag for Brad rather than guessing.
- The route's response body for 403/404 already includes a different identifier — adapt; do not duplicate.
