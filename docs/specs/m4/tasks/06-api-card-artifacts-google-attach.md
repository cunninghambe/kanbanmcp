# Task 06 — API route: `POST /api/cards/[cardId]/artifacts/google` (attach Google URL)

**Agent type:** coder
**Depends on:** 00-schema, 01-oauth, 02-drive, 05-oauth-routes
**Spec sections:** M4 spec — "Attaching a Google file/folder to a card" block, E1, E3, E4, E5, E6, E7, E8, E9, E11, E12, E20, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-20 (parentArtifactId)

---

## Goal

Implement the single route that turns a Drive URL into one (file) or many (folder) `Artifact` rows. The route validates the URL, resolves it via Drive metadata, enforces caps for folders, and creates rows with the correct `source`, `storageKey`, `mimeType`, and (for folder children) `parentArtifactId`. It returns a 201 with the canonical artifact shape used elsewhere in the codebase.

## Inputs — files to read first

- `/opt/kanban/src/app/api/cards/[cardId]/artifacts/route.ts` — pattern for an authenticated card-scoped route (uses `resolveCard`, `requireOrgRole`)
- `/opt/kanban/src/lib/artifacts.ts` — `shapeArtifact` and the response shape
- `/opt/kanban/src/lib/google/drive.ts` — `parseDriveUrl`, `getFileMeta`, `listFolderRecursive`
- `/opt/kanban/src/lib/google/errors.ts`
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — attach-route block + edge cases E1, E3..E10, E11, E12, E17, E20

## Files to create / modify

**Create:**

- `/opt/kanban/src/app/api/cards/[cardId]/artifacts/google/route.ts`
- `/opt/kanban/src/lib/google/source-mapping.ts` — pure helper: `mimeType → Artifact.source` for Google content
- `/opt/kanban/__tests__/api/cards-google-attach.test.ts`

**Do NOT** modify the existing `route.ts` (file upload). Two siblings, one for each upload mode.

## Interface contract

### Route

```
POST /api/cards/[cardId]/artifacts/google
Content-Type: application/json
body: { url: string }

201 { artifact: ArtifactResponse, expandedArtifacts?: ArtifactResponse[] }
400 { error: 'INVALID_URL' }
401 { error: 'NOT_CONNECTED' }
403 { error: 'FORBIDDEN' }
404 { error: 'TRASHED' } | { error: 'NOT_FOUND' }
409 { error: 'UNSUPPORTED_TYPE' }
422 { error: 'PARTIAL_FOLDER', folder: ArtifactResponse, files: ArtifactResponse[], rejected: Array<{id, name?, reason}> }
502 { error: 'GOOGLE_HTTP_ERROR', status: number }
```

### `src/lib/google/source-mapping.ts`

```ts
import type { Prisma } from '@prisma/client'

export type GoogleSource = 'GOOGLE_DOC' | 'GOOGLE_SHEET' | 'GOOGLE_SLIDE' | 'GOOGLE_FOLDER'

const MIME_TO_SOURCE: Record<string, GoogleSource> = {
  'application/vnd.google-apps.document': 'GOOGLE_DOC',
  'application/vnd.google-apps.spreadsheet': 'GOOGLE_SHEET',
  'application/vnd.google-apps.presentation': 'GOOGLE_SLIDE',
  'application/vnd.google-apps.folder': 'GOOGLE_FOLDER',
}

export function mapMimeToSource(mimeType: string): GoogleSource | null
// Returns null for unsupported mime → caller maps to 409 UNSUPPORTED_TYPE.

export function buildStorageKey(source: GoogleSource, id: string): string
// 'GOOGLE_FOLDER' → 'gdrive://folder/<id>'
// others           → 'gdrive://<id>'
```

### Route algorithm (single happy-path narrative)

1. Auth: `requireSession`. 401 if unauth.
2. Resolve card; check `card.board.orgId === session.orgId`. 404 if mismatched.
3. `requireOrgRole(session, session.orgId, 'MEMBER')`.
4. Parse JSON body. `url: string` required. Else 400 `INVALID_URL`.
5. **API-key auth note:** mirror the existing upload route — if `session.isApiKeyAuth`, resolve `uploaderId` to the org's first ADMIN. Otherwise `uploaderId = session.userId`.
6. Confirm a `GoogleCredential` row exists for `uploaderId`. **Else 401 `NOT_CONNECTED`** (E1). Do NOT auto-redirect; the UI handles that.
7. `parsed = parseDriveUrl(url)`. If null → 400 `INVALID_URL` (E3).
8. **File path** (`parsed.kind === 'file'`):
   - `meta = await getFileMeta(uploaderId, parsed.id)`
   - Catches:
     - `DriveTrashedError` → 404 `TRASHED` (E4 / AC-9)
     - `DriveForbiddenError` → 403 `FORBIDDEN` (E5 / AC-10)
     - `DriveNotFoundError` → 404 `NOT_FOUND`
     - `GoogleHttpError` → 502 `GOOGLE_HTTP_ERROR` with status
   - `source = mapMimeToSource(meta.mimeType)`. If null → 409 `UNSUPPORTED_TYPE`.
   - `prisma.artifact.create` with:
     - `cardId`, `uploaderId`
     - `filename = meta.name`
     - `mimeType = meta.mimeType`
     - `sizeBytes = 0` (per spec)
     - `source` (the mapped enum string)
     - `storageKey = buildStorageKey(source, parsed.id)`
     - `parentArtifactId = null` (root attach)
   - 201 `{ artifact: shapeArtifact(row) }`
9. **Folder path** (`parsed.kind === 'folder'`):
   - `meta = await getFileMeta(uploaderId, parsed.id)` — same error mapping. If `meta.mimeType !== 'application/vnd.google-apps.folder'` → 409 `UNSUPPORTED_TYPE` (URL claimed folder but resolved to non-folder).
   - `enum = await listFolderRecursive(uploaderId, parsed.id, { maxDepth: 3, maxCount: 50, maxFileBytes: 5_242_880 })`
   - **Inside a Prisma transaction** (so partial failure leaves nothing behind):
     - Create folder Artifact row first (source=`GOOGLE_FOLDER`, storageKey=`gdrive://folder/<id>`, parentArtifactId=null, sizeBytes=0)
     - For each file in `enum.files`: create Artifact row with `parentArtifactId = <folder row id>`, mapped source, mapped storageKey
   - If `enum.rejected.length > 0`:
     - **AC-8:** 422 `{ folder, files, rejected }` (folder is still created, file children are still created; the partial-success status communicates the caps)
   - Else:
     - **AC-7:** 201 `{ artifact: <folder>, expandedArtifacts: [<files>] }`

10. Update `GoogleCredential.lastUsedAt = now` on successful path (file or folder). Best-effort; non-blocking; do not 5xx the request if this update fails (log warn).

11. Do **not** auto-trigger an AI review here. The existing M1 trigger endpoint (`POST /api/cards/.../artifacts/[id]/reviews`) handles that, and the card's `aiAutoReview` setting drives the auto path through `enqueueAiReview`.

12. **Special case:** if `card.aiAutoReview === true`, call `enqueueAiReview(<each non-folder artifact id>)` after the transaction commits, exactly as the existing upload route does. Do NOT enqueue the folder row (folders are not reviewable). Reuse the import from `@/lib/ai-review/queue`.

## Hard rules

1. **Atomicity for folders:** the folder row and all child rows are created in a single `prisma.$transaction`. If any child row creation fails, the whole batch rolls back. AC-20 (migration safety) explicitly notes nullable parentArtifactId so partial state is theoretically possible; we are explicit about preventing it.
2. **Status codes are spec-exact.** 401 NOT_CONNECTED, 400 INVALID_URL, 404 TRASHED/NOT_FOUND, 403 FORBIDDEN, 409 UNSUPPORTED_TYPE, 422 PARTIAL_FOLDER, 502 GOOGLE_HTTP_ERROR. Tests assert these.
3. **No new generic artifact shape.** Reuse `shapeArtifact`. If it needs a `parent` or `children` field, add it as nullable in `src/lib/artifacts.ts` in this same PR with a one-line spec note.
4. **No retries inside the route.** Drive errors propagate. Retries live inside the rate-limiter (Task 11), not here.
5. Functions ≤ 40 lines. Decompose: `resolveCard` (already exists), `attachFile`, `attachFolder`, `mapDriveError`.
6. **No `any`.** Body parsed with a small Zod schema (`z.object({ url: z.string().url() })`).
7. **Do not validate the URL via Zod's `.url()` alone** — Drive URLs are valid URLs by structure; the *meaning* check is `parseDriveUrl`. Use Zod to ensure `url` is a string, then call `parseDriveUrl`.
8. AI-review auto-enqueue mirrors the upload route's behaviour. Do not invent a new auto-review gate.

## Tests to write

`/opt/kanban/__tests__/api/cards-google-attach.test.ts` — mock `@/lib/google/drive` (`parseDriveUrl`, `getFileMeta`, `listFolderRecursive`) and `@/lib/ai-review/queue` (`enqueueAiReview`).

- **E1 / AC-13:** user has no GoogleCredential → 401 `NOT_CONNECTED`. No Drive calls made.
- **E3:** `parseDriveUrl` returns null → 400 `INVALID_URL`. No Drive calls.
- **E4 / AC-9:** `getFileMeta` throws `DriveTrashedError` → 404 `TRASHED`. No row created.
- **E5 / AC-10:** `getFileMeta` throws `DriveForbiddenError` → 403 `FORBIDDEN`. No row created.
- **NOT_FOUND:** `DriveNotFoundError` → 404 `NOT_FOUND`.
- **AC-4 prep (Doc happy path):** stub `parseDriveUrl` → file, `getFileMeta` → doc mime → 201; row has `source='GOOGLE_DOC'`, `storageKey='gdrive://X'`, `sizeBytes=0`. `parentArtifactId === null`.
- **Sheet / Slide happy paths:** same with mime variations → correct `source`.
- **UNSUPPORTED_TYPE:** `getFileMeta` returns mime `application/vnd.google-apps.form` → 409 `UNSUPPORTED_TYPE`. No row.
- **AC-7 (folder happy):** `parsed.kind='folder'`, folder mime returned, `listFolderRecursive` returns 3 files, 0 rejected → 201; response has `artifact` (folder, `source='GOOGLE_FOLDER'`) and `expandedArtifacts.length === 3`; each child has `parentArtifactId === folder.id`.
- **AC-8 (folder partial):** `listFolderRecursive` returns 50 files + 10 rejected `TOO_MANY_FILES` → 422; folder row still created; response includes 50 files + 10 rejected entries.
- **Folder URL but resolves to non-folder** → 409 `UNSUPPORTED_TYPE`. No row.
- **E20 (two users attach same URL):** test seeds two users + two cards; both attach the same `url`; expect two distinct Artifact rows with different ids, identical `storageKey`. No deduplication occurs.
- **API-key auth uploader resolution:** call route with API-key session; uploaderId resolves to the first org admin (mirrors upload route).
- **aiAutoReview = true:** card has `aiAutoReview=true`; on file attach `enqueueAiReview` is called once with the new artifact id. On folder attach (3 files), `enqueueAiReview` called three times with the file ids — NOT the folder id.
- **aiAutoReview = false:** no `enqueueAiReview` calls.
- **lastUsedAt update:** after a successful attach, `GoogleCredential.lastUsedAt` is updated to ~now.
- **Atomic folder failure:** stub the second child insert to throw → expect no folder row, no child row, full rollback.

## Verification gate (all must pass)

- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32) npx vitest run __tests__/api/cards-google-attach.test.ts`
- Full suite: `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — full or partial

- **AC-4 / AC-5 / AC-6 attach step** — full responsibility (review step lives in M1 worker + Task 04)
- **AC-7** (Folder expansion: artifact + expandedArtifacts) — full responsibility
- **AC-8** (Folder cap respected, 422 with rejected[]) — full responsibility
- **AC-9** (TRASHED) — full responsibility
- **AC-10** (FORBIDDEN) — full responsibility
- **AC-12** (Cross-user isolation: each user's attach uses their own credential) — full responsibility for the attach step; the review step is covered by the worker
- **AC-13** (Disconnected user re-attempt → NOT_CONNECTED) — full responsibility

## Out of scope

- The UI affordance (CardModal input) — Task 10
- Rate-limit around `getFileMeta` / `listFolderRecursive` — Task 11
- AI review semantics — already done in M1 + Task 04

## Done when

- Route implemented; all tests pass.
- Single commit on `feat/m4-06-card-attach`.

## Escalate if

- The existing artifact route's `enqueueAiReview` call shape changed since M1 — re-derive the contract before adding a similar call here.
- Prisma `$transaction` interacts oddly with `parentArtifactId` (e.g. ordering matters) — flag and capture the actual constraint.
