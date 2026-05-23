# Task 08 — Settings UI: `/settings/integrations` page + IntegrationRow component

**Agent type:** coder
**Depends on:** 05-oauth-routes
**Spec sections:** M4 spec — "Settings UI" block + AC-1, AC-2, AC-16

---

## Goal

Add a new settings sub-page at `/settings/integrations` with one row for Google. The row renders one of three states based on `GET /api/me/google/status`:

- **Disconnected** → "Connect Google" button (anchor to `/api/me/google/connect`)
- **Connected** → email + last-used timestamp + "Disconnect" button (calls `DELETE /api/me/google/disconnect`)
- **Expired** → "Reconnect Google" button + small explanatory line

Add an "Integrations" entry to the settings sidebar. No other integrations ship in M4; the component is designed so a future Slack/GitHub row drops in with no new abstraction.

## Inputs — files to read first

- `/opt/kanban/src/app/(app)/settings/page.tsx` — current settings landing + sidebar pattern
- `/opt/kanban/src/app/(app)/settings/api-keys/page.tsx` — pattern for a sub-page (auth wrapper, server component, SWR-style data, action handlers)
- `/opt/kanban/src/app/api/me/google/status/route.ts` (from Task 05) — the response shape this UI binds to
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — Settings UI block

## Files to create / modify

**Create:**

- `/opt/kanban/src/app/(app)/settings/integrations/page.tsx` — server component shell + sidebar entry
- `/opt/kanban/src/app/(app)/settings/integrations/IntegrationRow.tsx` — `'use client'`; one prop `integration: 'google'` for now; renders the three states; handles `Disconnect` action
- `/opt/kanban/__tests__/ui/IntegrationRow.test.tsx` — RTL tests against the three states

**Modify:**

- The existing settings sidebar (likely in `/opt/kanban/src/app/(app)/settings/layout.tsx` or in `page.tsx` — coder confirms). Add an "Integrations" link between "API Keys" and "Notifications" (or after "API Keys" if there is no "Notifications" yet).

**Do NOT** modify any other settings sub-page. Do NOT create a shared "integration registry" or pluggable framework — YAGNI; we have one integration.

## Interface contract

### `IntegrationRow`

```tsx
interface Props { integration: 'google' }

// Internal state machine:
type View =
  | { phase: 'loading' }
  | { phase: 'disconnected' }
  | { phase: 'connected'; email: string; lastUsedAt: string | null; scopes: string[] }
  | { phase: 'expired'; email: string }
  | { phase: 'error'; message: string }
```

Behaviour:

- On mount: `fetch('/api/me/google/status')` → set view per response
- Disconnected: button "Connect Google" — `<a href="/api/me/google/connect">` (browser follows the 302). Aria label "Connect Google account".
- Connected: shows `Connected as <email>`, `Last used: <relative time>` (or "Never" if null). Button "Disconnect" → `fetch('/api/me/google/disconnect', { method: 'DELETE' })`. On 204 → set view to `disconnected`. On non-204 → toast/error.
- Expired: shows `Connection expired — reconnect to keep AI reviews working.` Button "Reconnect Google" → same anchor as Connect (`/api/me/google/connect`).
- Error: shows the message + a small "Retry" button that re-fetches status.

Accessibility:
- Each button is a real `<button>` (not div).
- Status text has `aria-live="polite"` so screen readers announce transitions.
- After clicking "Disconnect", focus moves to the now-rendered "Connect Google" button.

### Page component

`page.tsx`:
- Server component
- Requires session (`requireSession`); 302 to `/login?redirect=/settings/integrations` if unauth
- Renders sidebar (reuses settings layout) and a single section: `<IntegrationRow integration="google" />`
- Reads `searchParams.connected === '1'` → show a one-time green toast "Google connected" (use the existing toast util if present; otherwise an inline banner that auto-dismisses on next interaction — keep it simple)

## Hard rules

1. **No design-system overhaul.** Match the existing settings page styling exactly. If the existing settings use specific class names or `<div>` patterns, mirror them.
2. **No new dependencies.** Use the existing toast/notification mechanism if any; otherwise plain DOM. Do not add `react-hot-toast` or similar.
3. **One row, hardcoded.** No registry pattern. The `integration` prop is `'google'` only; a future PR adds the second value.
4. **A11y: keyboard nav must work.** Test asserts tab order and that Enter on the Connect anchor activates it.
5. **No `any`.** Status response typed via the discriminated union from Task 05's contract — copy the type into a local `types.ts` if needed (do not import server-only modules into a client component).
6. **No emojis** in UI strings.
7. Component ≤ 200 lines.
8. **Date formatting:** use `Intl.RelativeTimeFormat` for "Last used: 3 hours ago". No `date-fns` if not already in deps.

## Tests to write

`/opt/kanban/__tests__/ui/IntegrationRow.test.tsx` — RTL + `vi.fn()` stubbed `fetch`.

- **Disconnected initial state:** stub `fetch('/api/me/google/status')` → `{ connected: false }`. Wait for render. Assert "Connect Google" button exists with the right `href`. Assert no "Disconnect" button.
- **Connected initial state (AC-1 surface):** stub → `{ connected: true, email: 'a@b.com', scopes: [...], lastUsedAt: null, expired: false }`. Assert "Connected as a@b.com" text. Assert "Last used: Never" text. Assert "Disconnect" button present.
- **Expired state (AC-16):** stub → `{ connected: true, email: 'a@b.com', scopes: [...], lastUsedAt: '...', expired: true }`. Assert "Reconnect Google" button. Assert no "Disconnect" button (the expired credential is unusable; the row encourages re-consent, not disconnect — though disconnect would also be valid; spec wording is "Reconnect Google"). Confirm by checking the spec.
- **Disconnect interaction (AC-2):** Connected state; click "Disconnect"; stub the DELETE → 204; row re-renders as Disconnected. Assert focus moved to the new "Connect Google" button.
- **Disconnect error:** DELETE returns 500 → error state shown; button can be clicked again.
- **Status fetch error:** initial fetch rejects → error state shown with "Retry"; clicking Retry re-fetches.
- **A11y:** Tab from page top should reach the Connect/Disconnect button in fewer than 5 tabs (assertion via `userEvent.tab()` loop with a counter).

## Verification gate (all must pass)

- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run __tests__/ui/IntegrationRow.test.tsx`
- Full suite: `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — full responsibility

- **AC-1** (UI shows "Connected as <email>" after consent return) — UI surface
- **AC-2** (Disconnect button works) — UI surface
- **AC-16** (UI shows "Expired — Reconnect" state) — UI surface

## Out of scope

- Other integrations (Slack, GitHub)
- Per-org admin view of who in the org has connected Google (privacy review pending; flag for M5)
- OAuth scope upgrade UX

## Done when

- Page renders all three states correctly.
- All UI tests pass.
- The settings sidebar shows "Integrations".
- Single commit on `feat/m4-08-settings-ui`.

## Escalate if

- The existing settings layout doesn't have a clean sidebar slot for a new entry — show Brad the proposed change before adding entries.
- Toast utility doesn't exist and Brad would prefer a different inline pattern.
