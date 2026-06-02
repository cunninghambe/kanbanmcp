# Task 10 — End-to-end integration test: mocked Google APIs through full review pipeline

**Agent type:** coder
**Depends on:** 00 through 09 (all M4 tasks)
**Spec sections:** M4 spec — full AC list, especially AC-4, AC-5, AC-6, AC-7, AC-11, AC-12

---

## Goal

A single Vitest suite that exercises the entire M4 happy-path stack with all Google APIs stubbed: OAuth callback → credential row → card attach (Doc / Sheet / Slides / Folder) → trigger review → assert `AiReview` row written with output reflecting the mocked content → assert comment posted on card. This is the gate that confirms the modules wired up by Tasks 00–09 actually compose correctly.

## Inputs — files to read first

- `/opt/kanban/__tests__/api/ai-review-pipeline.test.ts` (from M1 Task 05/10) — pattern for an integration test that mocks SDK + storage + uses `flushForTests`
- `/opt/kanban/src/lib/ai-review/worker.ts` — `flushForTests` semantics
- All Google modules: `oauth.ts`, `drive.ts`, `docs.ts`, `sheets.ts`, `slides.ts`, `fetch.ts`
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — ACs

## Files to create / modify

**Create:**

- `/opt/kanban/__tests__/integration/m4-google-end-to-end.test.ts`
- `/opt/kanban/__tests__/integration/helpers/mock-google-server.ts` — small in-process mock that satisfies the `googleFetch` interface via a URL-pattern dispatch table

**Do NOT** modify any production code in this task. If a real bug surfaces during integration, file an issue (as a code comment with `// TODO(m4-followup):`) and add a failing test that documents it — do not silently fix in this PR.

## Interface contract

### `helpers/mock-google-server.ts`

```ts
import type { GoogleFetch } from '@/lib/google/fetch'

export interface MockState {
  files: Record<string, {
    id: string
    name: string
    mimeType: string
    modifiedTime?: string
    size?: string
    trashed?: boolean
    children?: string[]              // for folders: child file ids
    docMarkdown?: string             // for docs
    sheetTabs?: Array<{ title: string; rows: string[][] }>
    slides?: Array<{ text: string; imageBytesB64: string[] }>
  }>
  tokenExchangeResponse?: {
    accessToken: string
    refreshToken: string
    expiresInSec: number
    scope: string                    // space-separated
  }
  userinfoResponse?: { email: string; sub: string }
}

export function installMockGoogleServer(state: MockState): {
  reset(): void
}
// Internally calls __setGoogleFetchForTests with a dispatcher that routes by URL prefix:
//   accounts.google.com/o/oauth2/* → ignored (consent URL is generated, not fetched)
//   oauth2.googleapis.com/token → tokenExchangeResponse
//   openidconnect.googleapis.com/v1/userinfo → userinfoResponse
//   www.googleapis.com/drive/v3/files/{id} (no /export) → files[id] meta
//   www.googleapis.com/drive/v3/files/{id}/export → files[id].docMarkdown
//   www.googleapis.com/drive/v3/files?q='{parent}' in parents → list children
//   sheets.googleapis.com/v4/spreadsheets/{id}? → tab metadata
//   sheets.googleapis.com/v4/spreadsheets/{id}/values/{tab} → rows
//   slides.googleapis.com/v1/presentations/{id} → slides
//   <slide-image-content-url> → base64-decode bytes
```

### The integration suite

A single `describe('M4 end-to-end (mocked Google)')` block with these tests:

1. **Setup helpers:**
   - `await createTestUser({ withGoogleCredential: false })` — fresh user
   - `await createTestCard(userId)` — fresh card
   - `await runOAuthCallback(userId)` — drives `GET /api/me/google/callback` with a valid state + matching cookie; sets up the credential row using the mocked token exchange
   - Stub `@anthropic-ai/sdk` (`messages.create`) to return a deterministic output that echoes the input — this lets us assert "the doc content reached Claude" via the output

2. **AC-1 + AC-2 (OAuth round-trip):**
   - `GET /api/me/google/status` → `{ connected: false }`
   - Run `runOAuthCallback`
   - `GET /api/me/google/status` → `{ connected: true, email: 'test@example.com', ... }`
   - `DELETE /api/me/google/disconnect` → 204
   - `GET /api/me/google/status` → `{ connected: false }`

3. **AC-4 (Doc end-to-end):**
   - Seed mock: `files['doc1']` with `docMarkdown: '# Strategy\n\nQ3 priorities are A, B, C.'`
   - Run OAuth
   - POST `/api/cards/<cardId>/artifacts/google` body `{ url: 'https://docs.google.com/document/d/doc1/edit' }`
   - 201; artifact row created with `source='GOOGLE_DOC'`, `storageKey='gdrive://doc1'`
   - POST `/api/cards/<cardId>/artifacts/<artifactId>/reviews` (M1 trigger)
   - `await flushForTests()`
   - AiReview row: `status='done'`, `output` contains the doc markdown (because the stubbed Claude echoes it)
   - Comment row posted on the card by the AI Reviewer user

4. **AC-5 (Sheet end-to-end):**
   - Seed: `files['sheet1']` with `sheetTabs: [{ title: 'Q3', rows: [['Revenue', '1000'], ['Costs', '600']] }]`
   - Attach → review → AiReview output contains the string `Revenue,1000` (post-CSV-encoding) — verifies cell content reached Claude (AC-5 wording: "output references at least one specific cell value")
   - Comment posted

5. **AC-6 (Slides multimodal):**
   - Seed: `files['slides1']` with `slides: [{ text: 'Plan', imageBytesB64: [<small png>] }, { text: 'Numbers', imageBytesB64: [] }]`
   - Attach → review
   - AiReview output: stubbed Claude is configured to introspect the `messages[0].content` array and return a summary like `"saw text Plan, saw 1 image; saw text Numbers, saw 0 images"`. Assert this string in `output`.
   - Verifies multimodal content array reached Claude; verifies routing went via Anthropic (not ClaudeMCP) — also stub `runViaClaudeMCP` to throw if called

6. **AC-7 (Folder happy):**
   - Seed: `files['folder1']` with `children: ['d1', 'd2', 'd3']`, each `d*` a doc
   - Attach `https://drive.google.com/drive/folders/folder1` → 201 with `artifact` (folder) + `expandedArtifacts.length === 3`
   - Each child has `parentArtifactId === folder.id`
   - Trigger reviews on each child → all reach `status='done'`; 3 comments posted

7. **AC-8 (Folder cap):**
   - Seed: folder with 60 doc children (programmatically)
   - Attach → 422; `files.length === 50`; `rejected.length === 10`
   - Folder row exists; first 50 child rows exist

8. **AC-9 (TRASHED):**
   - Seed: `files['trashed1']` with `trashed: true`
   - Attach → 404 `TRASHED`; no Artifact row created

9. **AC-10 (FORBIDDEN):**
   - Mock returns 403 for `files['forbidden1']`
   - Attach → 403 `FORBIDDEN`; no Artifact row

10. **AC-11 (Re-snapshot):**
    - Doc attach + review → first AiReview has `output` reflecting v1 content
    - Mutate the mock so `files['doc1'].docMarkdown = 'v2 content'`
    - POST a second review on the same artifact → second AiReview has `output` reflecting v2
    - First AiReview row's `output` unchanged

11. **AC-12 (Cross-user isolation):**
    - User A connects, attaches a doc to a shared card, reviews → success
    - User B (also in the org, but not Google-connected) views the card; the Artifact is visible
    - User B triggers a review on the same artifact → the worker uses User B's credentials → 401 NOT_CONNECTED surfaces as AiReview `status='failed'` with the error message
    - The original review (User A's) is unchanged

12. **AC-13 (Disconnected user, prior reviews preserved):**
    - User connects, attaches, reviews → success
    - User disconnects
    - Prior AiReview row still exists with its output
    - Re-trigger review on the same artifact → AiReview row written with `status='failed'` and `errorMessage` mentioning NOT_CONNECTED

13. **AC-19 (No refresh token leak):**
    - Wrap `console.log/warn/error` for the entire end-to-end Doc test; assert no log line contains the plaintext refresh token (mock used a known-fixed value)

## Hard rules

1. **No real network.** `__setGoogleFetchForTests` is installed in `beforeEach`; reset in `afterEach`. Same for the Anthropic SDK mock.
2. **Isolated DB per test.** Use a `:memory:` SQLite or `/tmp/m4-int-<uuid>.db` with `prisma migrate deploy` in `beforeEach`. No shared state.
3. **No flake.** Use `vi.useFakeTimers()` for any wait-based logic (token expiry, rate-limit refill). No `setTimeout` waits in test code.
4. **`flushForTests` is the single sync point** for review completion. Do not poll for AiReview status.
5. Tests assert side effects (Comment created, AiReview rows, GoogleCredential row) by querying the DB directly via `prisma`.
6. If a test depends on the mock's dispatch matching a URL pattern, add a defensive case in the mock that throws "Unmatched URL: <url>" for unknown URLs — surfaces wiring bugs immediately.
7. **No `any`.** Mock state typed; response shapes typed.

## Tests to write

The full suite above is the set of tests. No additional tests in this task.

## Verification gate (all must pass)

- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32) GOOGLE_OAUTH_CLIENT_ID=test GOOGLE_OAUTH_CLIENT_SECRET=test GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/me/google/callback npx vitest run __tests__/integration/m4-google-end-to-end.test.ts`
- Full suite: `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — full responsibility

Every AC has at least one test in this suite:

- AC-1, AC-2, AC-3 (refresh implicit in OAuth callback), AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14 (callback test in Task 05 covers), AC-15 (refresh rotation, unit-tested in Task 01 — integration here covers refresh-on-expired-token), AC-16 (status flow, covered in OAuth round-trip + Task 05), AC-17 (Task 05), AC-18 (rate-limit, Task 07), AC-19 (here, no-leak assertion), AC-20 (Task 00)

## Out of scope

- Tests against the real Google API (deferred to morning, post-credentials)
- Performance benchmarking
- Load tests of the rate limiter (covered as unit, not integration)

## Live-credential note (from spec)

After this task lands, Brad's morning steps to flip live:

1. Create OAuth client in Google Cloud Console, enable Drive / Docs / Sheets / Slides APIs
2. Set env vars `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI=https://<host>/api/me/google/callback`
3. Add the redirect URI to the OAuth client's authorized list
4. Restart the kanban service
5. Visit `/settings/integrations` → Connect Google → verify

No code change required for any of those. The mock layer is silent when env vars are present and real `fetch` is used; the test mock is only installed inside test files.

## Done when

- Integration suite exists and passes locally with all mocks.
- Single commit on `feat/m4-10-integration`.
- An `Out-of-scope live verification` note appears at the bottom of the PR description with the four steps above.

## Escalate if

- A test reveals a real wiring bug across two prior tasks — file the bug as a code comment, leave the test failing with `it.skip` and a TODO, push, and ping for a follow-up task. Do not silently fix.
- The mock dispatcher grows past ~300 LOC — refactor into per-product files (`mock-drive.ts`, `mock-sheets.ts`, etc.) under `helpers/`.
