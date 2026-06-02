# M4: External-doc AI review (Google Drive / Docs / Sheets / Slides)

## Status
Spec, drafted 2026-05-22. Awaiting Brad's final go.

Pairs with [M5](./m5-suggest-mode-writeback.md) (to-be-drafted), which adds Google Docs comment write-back. M4 is strictly read-only.

## Problem statement

Today, AI review only operates on artifacts the user has uploaded into kanban (or on a card's description). Real teams keep work product in shared Google Drive — strategy docs, financial models, slide decks, project folders. Asking a user to download-then-reupload is friction that breaks the loop.

M4 lets a user attach a Google Drive URL to a card and trigger AI review against the live Google content. The review uses the user's own Google permissions (per-user OAuth), runs on a one-shot snapshot at trigger time, and posts results back to the kanban card exactly the way M1 file-upload reviews do today. No code changes are needed in `ai-review/worker.ts` beyond a new extractor branch.

## Boundaries

### In scope
- Per-user Google OAuth (Drive readonly + Docs readonly + Sheets readonly + Slides readonly scopes)
- Refresh-token storage encrypted at rest using the existing `src/lib/secrets.ts` AES-GCM helper
- Four Google file types as `Artifact.source` values:
  - `GOOGLE_DOC` — exported as markdown via Drive `export` endpoint
  - `GOOGLE_SHEET` — per-tab CSV, concatenated with sheet-name headers
  - `GOOGLE_SLIDE` — per-slide text extraction; image-bearing slides traverse the multimodal path (one image per slide, captioned with slide number)
  - `GOOGLE_FOLDER` — recursive enumeration with depth cap (3), file-count cap (50), file-size cap (5MB per file); each contained file is reviewed independently and the card receives one `AiReview` per file
- One-shot snapshot at trigger time. Re-running the review re-snapshots; the previous snapshot is not retained.
- Settings UI surface: per-user "Connect Google" button with status (connected, expired, disconnected) and disconnect action
- Card UI surface: a new "Attach Google link" input on the card detail panel that accepts a Drive URL, resolves to an `Artifact` row, and surfaces inline with uploaded artifacts
- All existing M1 review flow reused: trigger via existing artifact-attached path, results render in the same artifact-review panel
- Rate-limit + retry handling on Google API calls (token-bucket per user, exponential backoff on 429/5xx)

### Out of scope (defer to M5 or later)
- Write-back of any kind. Read-only.
- Live re-review on doc edit (Drive `changes` API, push notifications)
- Scheduled review (cron-driven re-snapshot)
- Per-org service account model (only per-user OAuth)
- Anything other than Drive/Docs/Sheets/Slides — no Forms, no Sites, no Calendar
- PDF rendering of Slides (slides go via text + per-slide image; PDF export deferred)
- Multi-tab Sheets formula resolution beyond what Drive's CSV export already does
- Permission propagation between collaborators on the same kanban card (each kanban user uses their own Google identity; cross-user implicit access not granted)
- Sharing the same Drive URL across multiple cards (each attachment is independent; resolving the same URL on two cards creates two `Artifact` rows)

## Interface contract

### Prisma schema additions

```prisma
model GoogleCredential {
  userId        String   @id
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  // OAuth tokens (refreshToken encrypted at rest via src/lib/secrets.ts)
  accessToken          String?
  refreshTokenEncrypted String  // ciphertext only; never log or surface
  accessTokenExpiresAt DateTime?

  // Identity captured for display + verification on re-auth
  googleEmail   String
  googleSub     String   @unique  // Google's stable user id

  scopes        String   // space-separated; verify on use

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  lastUsedAt    DateTime?

  @@map("google_credentials")
}
```

Existing `Artifact.source` already lists the four `GOOGLE_*` values as reserved (`prisma/schema.prisma:Artifact` comment). M4 implements them. No additional column on `Artifact`. The Drive URL itself is captured in `storageKey` as `gdrive://<fileId>` for `GOOGLE_DOC|SHEET|SLIDE` and `gdrive://folder/<folderId>` for `GOOGLE_FOLDER`. `filename` is the Google file's title at snapshot time. `mimeType` mirrors Google's `application/vnd.google-apps.{document,spreadsheet,presentation,folder}`. `sizeBytes = 0` for Google sources (size only meaningful for downloaded content; reviewed-content size is captured in `AiReview.inputTokens`).

### New API routes

```ts
// OAuth lifecycle (per-user)
GET    /api/me/google/connect      // 302 → Google consent screen with state cookie
GET    /api/me/google/callback     // OAuth code exchange, stores GoogleCredential, 302 → /settings/integrations
DELETE /api/me/google/disconnect   // revokes Google-side, deletes GoogleCredential row
GET    /api/me/google/status       // { connected: bool, email?: string, scopes?: string[], lastUsedAt?: string }

// Attaching a Google file/folder to a card
POST   /api/cards/[cardId]/artifacts/google
  body: { url: string }
  → 201 { artifact: Artifact, expandedArtifacts?: Artifact[] }  // expandedArtifacts populated when url resolves to a folder
  → 400 if url is not a Drive URL
  → 401 if requester is not Google-connected
  → 403 if Google denies access to the resolved fileId
  → 404 if the resolved fileId doesn't exist (or is in trash)
  → 422 if folder enumeration exceeds depth/count/size caps; response body lists what was rejected
```

Triggering review: existing `POST /api/cards/[cardId]/artifacts/[artifactId]/reviews` works unchanged. The worker dispatches on `Artifact.source` in the extractor (see below). No new review route.

### New module: `src/lib/google/`

```ts
// src/lib/google/oauth.ts
export function buildConsentUrl(userId: string, state: string): string
export async function exchangeCode(code: string): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: Date
  email: string
  sub: string
  scopes: string[]
}>
export async function refreshAccessToken(userId: string): Promise<string>
// Reads GoogleCredential, decrypts refreshToken, calls Google token endpoint,
// updates accessToken + expiresAt. Returns the fresh accessToken.
// Throws TokenRevokedError on Google's invalid_grant.
export class TokenRevokedError extends Error {}
export class GoogleAuthExpiredError extends Error {}  // covers expired AND not-connected

// src/lib/google/drive.ts
export interface DriveFileMeta {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  sizeBytes: number | null  // null for Google-native types
  trashed: boolean
}
export function parseDriveUrl(url: string): { kind: 'file' | 'folder', id: string } | null
export async function getFileMeta(userId: string, fileId: string): Promise<DriveFileMeta>
export async function listFolderRecursive(
  userId: string,
  folderId: string,
  opts: { maxDepth: number; maxCount: number; maxFileBytes: number }
): Promise<{ files: DriveFileMeta[]; rejected: Array<{ id: string; reason: string }> }>

// src/lib/google/docs.ts
export async function exportDocAsMarkdown(userId: string, fileId: string): Promise<string>

// src/lib/google/sheets.ts
export async function exportSheetAsCsv(userId: string, fileId: string): Promise<string>
// Returns concatenated CSV: '## Sheet: <name>\n<csv>\n\n## Sheet: <name>\n<csv>\n...'

// src/lib/google/slides.ts
export interface SlideContent {
  slideIndex: number
  text: string                // concatenated text frames
  imageDataUrls: string[]     // base64 image PNG per inserted image; capped at 5/slide
}
export async function extractSlides(userId: string, fileId: string): Promise<SlideContent[]>
```

### Extension to `src/lib/ai-review/extractors.ts`

The existing `extractContent(artifact: Artifact): Promise<ExtractedContent>` already dispatches on `mimeType`. Add a top-level branch on `artifact.source`:

```ts
if (artifact.source === 'GOOGLE_DOC')   return { kind: 'text',  text: await exportDocAsMarkdown(uploaderId, fileId) }
if (artifact.source === 'GOOGLE_SHEET') return { kind: 'text',  text: await exportSheetAsCsv(uploaderId, fileId) }
if (artifact.source === 'GOOGLE_SLIDE') return { kind: 'multimodal', segments: [...] }  // new ExtractedContent variant
if (artifact.source === 'GOOGLE_FOLDER') /* unreachable — folders expand to file artifacts at attach time, not at review time */
```

`ExtractedContent` gains a third variant:

```ts
export type ExtractedContent =
  | { kind: 'text';  text: string }
  | { kind: 'image'; imageBase64: string; imageMimeType: string }
  | { kind: 'multimodal'; segments: Array<
      | { kind: 'text'; text: string }
      | { kind: 'image'; imageBase64: string; imageMimeType: string }
    > }
```

`claude-client.ts` already supports text and image via the existing Anthropic SDK call shape. Add a multimodal branch that builds the `messages[0].content` array with interleaved text and image blocks. Estimated +20 LOC.

### Settings UI

New route `/settings/integrations` with one row per integration. M4 ships just the Google row:
- Disconnected: "Connect Google" button → `GET /api/me/google/connect`
- Connected: shows email + last-used timestamp + "Disconnect" button → `DELETE /api/me/google/disconnect`
- Token expired (refresh failed): "Reconnect Google" button + small explanatory line

The existing Settings page already has a sidebar; add an "Integrations" entry between "API Keys" and "Notifications".

### Card UI

In `CardModal.tsx`, alongside the existing "Upload file" affordance, add a "Attach Google link" affordance:
- Text input accepting a Drive URL
- On paste/submit: POST `/api/cards/[cardId]/artifacts/google`
- On 401: inline prompt → "Connect Google" link to `/settings/integrations`
- On 403 / 404: inline error with the Google file id (for debugging)
- On 422 (folder cap): list of rejected children + "attached N files" success summary
- On 201: artifact appears in the artifact list with a small Google icon and the file's Google title

### Rate limiting

Token-bucket per `userId`, capacity 60 tokens, refill 60/min. Each Google API call consumes 1 token; folder enumeration consumes 1 per child fetch. Bucket lives in-memory (single process — multi-instance left to a future Redis migration, same as the proxy rate limiter follow-up). When empty, block (`await sleep(ms-until-refill)`) up to 30s; beyond that, surface the underlying call as failed with `RateLimitExceededError`.

Google's per-user quota for Drive is generous (~1,000 requests / 100s); the bucket exists to prevent a runaway folder enumeration from saturating the user's quota, not to throttle normal use.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| E1 | User attaches a Drive URL but has never connected Google | 401 with `code: 'NOT_CONNECTED'`. UI prompts to connect. |
| E2 | User's stored refreshToken returns `invalid_grant` from Google | `TokenRevokedError`. Wipe `accessToken`/`accessTokenExpiresAt` from the row but keep the row so the UI shows "expired — reconnect". Next call attempts re-auth. |
| E3 | Drive URL is malformed or points to a non-Drive host | 400 with `code: 'INVALID_URL'`. Input field highlights with inline error. |
| E4 | URL resolves but file is in Drive trash | 404 with `code: 'TRASHED'`. |
| E5 | URL resolves but Google returns 403 (user lacks access) | 403 with `code: 'FORBIDDEN'`. UI shows "You don't have access to this file in Google." No silent fallback. |
| E6 | URL resolves to a folder | Enumerate per the caps. Create one `Artifact` row per file with `parentArtifactId = <folder artifact id>` (new optional column — see Schema additions below). Return all artifacts in `expandedArtifacts`. The folder itself also gets an Artifact row (`source = GOOGLE_FOLDER`, `mimeType = application/vnd.google-apps.folder`) for traceability — it does not receive its own review. |
| E7 | Folder has >50 files | Take first 50 (Drive's default ordering: alphabetical by name). Return 422 with `rejected[]` containing the excluded ids and a `'TOO_MANY_FILES'` reason. |
| E8 | Folder has files >5MB | Skip oversized files. Include them in `rejected[]` with `'TOO_LARGE'`. |
| E9 | Folder depth >3 | Stop descending. Include the deeper subfolder ids in `rejected[]` with `'DEPTH_EXCEEDED'`. |
| E10 | Folder contains unsupported file types (e.g., `.zip`) | Skip silently. Don't list in `rejected[]` (different from caps — these were never going to be reviewable). |
| E11 | Doc is private to the user; they review it, then later disconnect Google | The `Artifact` row remains. Re-running the review fails with `NOT_CONNECTED`. The original review output is preserved on the card. |
| E12 | Doc is edited after the snapshot was taken | The previous `AiReview.output` is preserved; re-running the review snapshots the new content and creates a new `AiReview` row. No diff between snapshots is surfaced (out of scope). |
| E13 | Slide with >5 inserted images | Take first 5 by appearance order, append a text note `[N additional images not included]` to the slide's text segment. |
| E14 | Sheet with >100 rows × 26 columns on any tab | Truncate per tab; truncated rows replaced by `... (N rows truncated)`. Hard cap protects against runaway CSV expansion. Per-cell content not truncated. |
| E15 | Drive returns 401 mid-call due to clock skew on expired-but-not-yet-refreshed access token | Catch; force a refresh; retry once. Surface failure on second 401. |
| E16 | User connects Google, attaches a doc, then the kanban admin deletes the user from the org | Standard cascade: User delete → GoogleCredential delete (cascade) → Artifact delete (cascade via existing `cardId` cascade only if card is deleted; otherwise the Artifact's uploaderId becomes a dangling reference). Existing M1 behavior; M4 does not change. |
| E17 | Folder is shared with the user but contains files the user can't see individually | Drive returns 403 for the unauthorized files when enumerated. Skip with `'FORBIDDEN_CHILD'` in `rejected[]`. |
| E18 | OAuth state cookie missing or mismatched on callback | 400 with `code: 'STATE_MISMATCH'`. Common CSRF mitigation. |
| E19 | User declines one of the requested scopes on consent | Inspect the granted-scopes string in the token response; if any required scope missing, refuse to store credential and 400 with `code: 'INSUFFICIENT_SCOPES'`. User must restart consent with all scopes. |
| E20 | Two users attach the same Google doc URL to two different cards | Two independent Artifact rows. Two independent reviews. They can produce different outputs if the users' permissions or the doc state differ at snapshot time. Acceptable. |
| E21 | Google API outage (sustained 5xx) | Retry up to 3 times with exponential backoff (1s, 4s, 16s). On final failure: AiReview row created with `status='failed'`, `errorMessage` references the Google error. Comment posted on card. |
| E22 | Refresh token rotation (Google's "limit 50 refresh tokens per OAuth client per user") | Always store the latest `refreshToken` returned on token exchange. If a refresh response includes a new `refreshToken`, replace the stored one. |

### Additional schema for E6 (folder → children traceability)

```prisma
model Artifact {
  // ...existing fields...
  parentArtifactId String?
  parent           Artifact?  @relation("ArtifactChildren", fields: [parentArtifactId], references: [id], onDelete: SetNull)
  children         Artifact[] @relation("ArtifactChildren")
}
```

Only set for files that came from a folder expansion. Null for direct uploads and direct file attaches.

## Acceptance criteria

1. **OAuth happy path** — Click "Connect Google" → consent → return to `/settings/integrations` → status shows "Connected as <email>". `google_credentials` row exists with non-null `accessToken`, encrypted `refreshTokenEncrypted`, `expiresAt` ~1 hour in the future.
2. **Disconnect** — Click "Disconnect" → row deleted → Google's OAuth revoke endpoint called. Subsequent `POST /api/cards/.../artifacts/google` returns 401.
3. **Token refresh transparent** — A request issued after `accessToken` has expired auto-refreshes and succeeds. Stored `accessToken` and `expiresAt` are updated.
4. **Doc review end-to-end** — User attaches a Google Doc URL → Artifact row created with `source='GOOGLE_DOC'` → user triggers review → review completes with output that reflects the doc's actual contents. The extracted markdown is what got sent to Claude (verifiable via `instructions` snapshot or test fixture).
5. **Sheet review end-to-end** — Same flow on a Google Sheet → output references at least one specific cell value from the source spreadsheet.
6. **Slides multimodal review** — Same flow on a Google Slides deck with both text and images → review output references both textual content AND visual content from a slide that had an inserted image.
7. **Folder expansion** — Attach a Drive folder with 3 supported files → response includes `artifact` (the folder, `source='GOOGLE_FOLDER'`) and `expandedArtifacts` (length 3, all with `parentArtifactId = folder.id`). Each child can be reviewed independently.
8. **Folder cap respected** — Attach a folder with 60 files → response is 422; first 50 by name are attached, the remaining 10 appear in `rejected[]` with `reason='TOO_MANY_FILES'`. Folder Artifact is still created.
9. **Trashed file rejected** — Attach a URL to a doc you've moved to trash → 404 with `code='TRASHED'`. No Artifact created.
10. **Forbidden file rejected** — Attach a URL to a doc that exists but you can't see → 403 with `code='FORBIDDEN'`. No Artifact created.
11. **Re-snapshot on re-review** — Edit the source doc between two review runs on the same Artifact → the second AiReview's content (verifiable via output) reflects the edits. The first AiReview is preserved unchanged.
12. **Cross-user isolation** — User A connects Google and attaches a private doc. User B in the same org views the card; the Artifact row is visible (it's on the card), but if User B triggers a review, the review uses User B's Google credentials (not A's). If B has no access, the review fails with `FORBIDDEN`.
13. **Disconnected user, prior reviews preserved** — User connects, attaches doc, reviews, then disconnects. Card still shows the prior review output. Attempting to re-review returns `NOT_CONNECTED`.
14. **Missing scope refused** — Run the OAuth flow but Google grants only `drive.readonly` (not `docs.readonly`). Callback returns 400 with `code='INSUFFICIENT_SCOPES'`. No credential stored.
15. **Refresh token rotation persisted** — When Google issues a new `refreshToken` on a refresh response, the stored encrypted value is updated. (Test via a stubbed token endpoint that returns a new refreshToken.)
16. **Refresh token revoked** — Manually revoke the user's Google grant. Next API call returns `TokenRevokedError`. UI status shows "Expired — Reconnect".
17. **CSRF protection** — A callback request with a mismatched `state` parameter is rejected with 400 `STATE_MISMATCH`. No code exchange attempted.
18. **Rate-limit handling** — Synthetic 60+ rapid folder attaches by the same user → the bucket throttles; no Google API calls beyond 60 per minute. Throttling adds latency but does not 5xx.
19. **Refresh token never logged** — Search the worker + API logs after a successful end-to-end run; no occurrence of the plaintext refresh token, decrypted access token, or the encryption key.
20. **Migration safe** — Applying the M4 migration on the live DB does not drop or alter any existing row in `users`, `cards`, `artifacts`, or `ai_reviews`. New `google_credentials` table is empty. New `parentArtifactId` column on `artifacts` is nullable and defaults to NULL — existing rows unaffected.

## Architecture decision

- New module: `src/lib/google/` (oauth, drive, docs, sheets, slides — five files; ~150 LOC each). No top-level `index.ts` re-export; consumers import file-paths directly. Mirrors the `ai-review/` pattern but does not import from it.
- One extension to `src/lib/ai-review/extractors.ts`: dispatch on `artifact.source` before mime sniffing.
- One extension to `src/lib/ai-review/claude-client.ts`: support the new `multimodal` `ExtractedContent` variant (interleaved text + image blocks in the messages array).
- Reuse `src/lib/secrets.ts` for refresh-token encryption. **Do not roll a new crypto helper.** This is a hard rule.
- One Prisma migration: add `google_credentials` table; add nullable `parentArtifactId` column with self-relation on `artifacts`.
- New routes under `src/app/api/me/google/{connect,callback,disconnect,status}/route.ts` plus `src/app/api/cards/[cardId]/artifacts/google/route.ts`.
- Settings UI: `src/app/(app)/settings/integrations/page.tsx` with one `<IntegrationRow integration="google" />` server component for now (extensible to other integrations later).
- Card UI: extend the existing `CardModal.tsx` artifact-attach affordance; do not split into a new component.
- Env vars:
  - `GOOGLE_OAUTH_CLIENT_ID` (required for connect flow)
  - `GOOGLE_OAUTH_CLIENT_SECRET` (required)
  - `GOOGLE_OAUTH_REDIRECT_URI` (required — typically `${NEXTAUTH_URL}/api/me/google/callback`)
  - `GOOGLE_SCOPES_OVERRIDE` (optional; defaults to the four readonly scopes)
- ClaudeMCP routing (PR #28): unchanged. Google content goes through `runViaClaudeMCP` for text-only artifacts (Docs, Sheets) and through `runViaAnthropic` for multimodal (Slides) since ClaudeMCP can't carry image payloads.

### Decisions deliberately deferred

- **Slides → PDF rendering.** Would unify all formats as multimodal-PDF. Heavier dep tree; defer until needed.
- **Per-org service account auth.** Brad decided per-user OAuth is the M4 model. Org accounts could be M6.
- **Drive `changes` API for live re-review.** Spec is explicit: one-shot snapshot. M5 deferred too.
- **Sharing the same Google doc Artifact across cards.** Each attach is independent. Pursuing a shared model would require an Artifact-deduplication layer that doesn't exist today.

## Open / deferred

- **Quota-exhaustion UX.** When the per-user Google quota is genuinely hit (not just the local token bucket), what does the user see? M4 returns an error; M5 might add a wait-and-retry UX.
- **Docs with linked images from outside Drive.** The Docs export-as-markdown does not embed external images. Acceptable; the textual review still operates on the prose. Document this caveat in the UI? Defer.
- **Drive Shortcuts.** A shortcut resolves to a target file; should attaching the shortcut resolve transparently? Probably yes. Mark in implementation: if `mimeType === 'application/vnd.google-apps.shortcut'`, follow the `shortcutDetails.targetId`. Add as edge case during implementation.
- **Workspace MIME types we haven't enumerated** (Jamboard, MyMaps). Reject at attach time with `UNSUPPORTED_TYPE`. Add to E10's reject list rather than silently dropping.
- **Multi-account per user.** A user may want to attach a personal-Google doc and a work-Google doc. Not in scope; one credential per user.
- **OAuth incremental scope upgrade.** If M5 adds the write scope, existing users will need to reconsent. Plan the re-consent flow in M5's spec; not M4's problem.
