# Task 02 — `src/lib/google/drive.ts`: URL parsing, file metadata, recursive folder enumeration

**Agent type:** coder
**Depends on:** 00-schema, 01-oauth
**Spec sections:** M4 spec — `src/lib/google/drive.ts` block, E3, E4, E5, E6, E7, E8, E9, E10, E17

---

## Goal

Implement Drive URL parsing (file vs folder), single-file metadata fetch, and recursive folder enumeration with depth / count / file-size caps. All HTTP goes through the `googleFetch` wrapper from Task 01 — fully unit-testable without live credentials.

## Inputs — files to read first

- `/opt/kanban/src/lib/google/oauth.ts` — `ensureFreshAccessToken` (use this for every call; never read tokens directly)
- `/opt/kanban/src/lib/google/fetch.ts` — `googleFetch`, `__setGoogleFetchForTests`
- `/opt/kanban/src/lib/google/errors.ts` — error classes; you may add `DriveNotFoundError`, `DriveForbiddenError`
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — drive.ts block + E3, E4, E5, E6 (folder semantics), E7/E8/E9 (caps), E10, E17

## Files to create / modify

**Create:**

- `/opt/kanban/src/lib/google/drive.ts`
- `/opt/kanban/__tests__/lib/google/drive.test.ts`

**Modify:**

- `/opt/kanban/src/lib/google/errors.ts` — append `DriveNotFoundError` (`code: 'DRIVE_NOT_FOUND'`), `DriveForbiddenError` (`code: 'DRIVE_FORBIDDEN'`), `DriveTrashedError` (`code: 'DRIVE_TRASHED'`)

## Interface contract

```ts
export interface DriveFileMeta {
  id: string
  name: string
  mimeType: string
  modifiedTime: string  // ISO string straight from Drive
  sizeBytes: number | null  // null for Google-native types
  trashed: boolean
}

export interface ParsedDriveUrl {
  kind: 'file' | 'folder'
  id: string
}

export function parseDriveUrl(url: string): ParsedDriveUrl | null
// Returns null for non-Drive URLs (caller maps null → 400 INVALID_URL).
// Recognised shapes (the four common Drive URL patterns):
//   https://docs.google.com/document/d/<ID>/edit               → file
//   https://docs.google.com/spreadsheets/d/<ID>/edit           → file
//   https://docs.google.com/presentation/d/<ID>/edit           → file
//   https://drive.google.com/file/d/<ID>/view                  → file
//   https://drive.google.com/open?id=<ID>                      → file
//   https://drive.google.com/drive/folders/<ID>                → folder
//   https://drive.google.com/drive/u/<N>/folders/<ID>          → folder
// Strip query/fragment except `id=` param. Trim whitespace. Case-insensitive host match.

export async function getFileMeta(userId: string, fileId: string): Promise<DriveFileMeta>
// GET https://www.googleapis.com/drive/v3/files/<id>
//   ?fields=id,name,mimeType,modifiedTime,size,trashed
//   &supportsAllDrives=true
// Authorization: Bearer <ensureFreshAccessToken(userId)>
//
// On 404 → throw DriveNotFoundError.
// On 403 → throw DriveForbiddenError.
// On returned trashed=true → throw DriveTrashedError (E4).
// On other non-2xx → throw GoogleHttpError.
// Shortcut handling (deferred edge case from spec "Open / deferred"):
//   if mimeType === 'application/vnd.google-apps.shortcut' →
//     re-fetch the target via shortcutDetails.targetId (one hop only; nested shortcuts → throw GoogleHttpError(0, 'NESTED_SHORTCUT'))

export interface FolderEnumOpts {
  maxDepth: number   // default 3 (folder root counts as depth 1)
  maxCount: number   // default 50
  maxFileBytes: number  // default 5_242_880 (5 MB)
}

export type RejectionReason =
  | 'TOO_MANY_FILES'
  | 'TOO_LARGE'
  | 'DEPTH_EXCEEDED'
  | 'FORBIDDEN_CHILD'
  | 'UNSUPPORTED_TYPE'

export interface FolderEnumResult {
  files: DriveFileMeta[]
  rejected: Array<{ id: string; name?: string; reason: RejectionReason }>
}

export async function listFolderRecursive(
  userId: string,
  folderId: string,
  opts: FolderEnumOpts
): Promise<FolderEnumResult>
// BFS from folderId. At each level call
//   GET drive/v3/files?q='<parent>' in parents and trashed=false
//     &fields=files(id,name,mimeType,modifiedTime,size,trashed)
//     &pageSize=100&orderBy=name
//   (paginate via nextPageToken until exhausted)
//
// Per spec semantics:
//   - The folder ITSELF is not in `files` — caller creates the folder Artifact separately.
//   - Subfolders are descended (E6) up to maxDepth. If a subfolder would be at depth > maxDepth,
//     push it to rejected with reason 'DEPTH_EXCEEDED'.
//   - Files with size > maxFileBytes → rejected with 'TOO_LARGE' (E8).
//   - Files of unsupported types (anything not in the SUPPORTED set below) → silently skipped
//     (E10; NOT added to rejected[]).
//   - Children that return 403 mid-enumeration → rejected with 'FORBIDDEN_CHILD' (E17).
//   - Once files.length >= maxCount, remaining encountered files of supported type → rejected with
//     'TOO_MANY_FILES'. Ordering is alphabetical by name at each level (Drive's orderBy=name).
//
// SUPPORTED_MIME_TYPES set:
//   - application/vnd.google-apps.document
//   - application/vnd.google-apps.spreadsheet
//   - application/vnd.google-apps.presentation
//   - application/vnd.google-apps.folder  (not added to files; used to recurse)
//   - Workspace-native unsupported variants (e.g. application/vnd.google-apps.form,
//     application/vnd.google-apps.jam, application/vnd.google-apps.map) are silently skipped.
```

## Hard rules

1. **No `googleapis` SDK.** All HTTP via `googleFetch`.
2. **Token acquisition is centralised:** every call begins with `await ensureFreshAccessToken(userId)`. Do not cache tokens locally inside this module.
3. **Caps are non-negotiable.** Hard-fail on `maxDepth ≤ 0` or `maxCount ≤ 0` with `Error('Invalid FolderEnumOpts')` — these must never be unset by callers.
4. Test must **not** make real network calls — stub `googleFetch`.
5. URL parser is pure (no Drive HTTP). It's a string-only function and must be tested as such.
6. Functions ≤ 40 lines. The BFS loop will be tight; extract pagination + level-walk helpers.
7. **No `any`.** Drive responses are JSON; declare a type or Zod schema per response shape (`DriveFileResource`, `DriveListResponse`).

## Tests to write

`/opt/kanban/__tests__/lib/google/drive.test.ts` — stub `googleFetch`, stub `ensureFreshAccessToken` via `vi.mock('@/lib/google/oauth', ...)`.

- **parseDriveUrl (pure, E3)**
  - All seven URL shapes above parse correctly with the right `kind`
  - Trailing slashes, query strings, fragments tolerated
  - Returns `null` for: `https://example.com/foo`, `https://docs.google.com/forms/d/X/edit` (forms unsupported), `not a url`, `''`
  - Returns `null` for `https://drive.google.com/drive/my-drive` (no id)

- **getFileMeta**
  - Happy path returns shaped DriveFileMeta with `sizeBytes` correctly numeric when Drive returns `"size": "12345"`, null when omitted (Google-native types)
  - 404 → `DriveNotFoundError`
  - 403 → `DriveForbiddenError`
  - `trashed: true` → `DriveTrashedError` (E4)
  - Other 5xx → `GoogleHttpError(<status>, <body>)`
  - Shortcut path: stub returns `mimeType: 'application/vnd.google-apps.shortcut'` and `shortcutDetails.targetId='X'`; expect a second `googleFetch` call for `files/X`; return that meta
  - Nested shortcut (shortcut points to shortcut) → throws `GoogleHttpError(0, 'NESTED_SHORTCUT')`

- **listFolderRecursive — E6 happy path**
  - Folder with 3 supported docs → `files.length === 3`, `rejected === []`
  - Files are sorted alphabetically by name (Drive's `orderBy=name`)

- **listFolderRecursive — E7 TOO_MANY_FILES**
  - Folder with 60 supported docs (paginated across 1 list call) → `files.length === 50`, `rejected.length === 10`, each rejection has `reason: 'TOO_MANY_FILES'`, the rejected ids are alphabetically the last 10

- **listFolderRecursive — E8 TOO_LARGE**
  - Folder with 1 file at size 6 MB and 1 file at size 1 MB → `files.length === 1` (the 1MB), `rejected.length === 1` with `reason: 'TOO_LARGE'`

- **listFolderRecursive — E9 DEPTH_EXCEEDED**
  - Root folder F0 → contains F1 → F2 → F3 → F4 (a doc inside F4). With `maxDepth=3`, F1+F2+F3 are descended; F4 is rejected with `DEPTH_EXCEEDED`. The doc inside F4 is **not** enumerated and not in `rejected[]`.

- **listFolderRecursive — E10 silently skip unsupported types**
  - Folder with 1 supported doc + 1 `application/vnd.google-apps.form` → `files.length === 1`, `rejected.length === 0` (form not in rejected[])

- **listFolderRecursive — E17 FORBIDDEN_CHILD**
  - First list call returns 3 files; `getFileMeta`-style enumeration is via list (no per-file fetch), but a child folder we recurse into returns 403 on its list call → root folder's `rejected[]` contains that subfolder id with `reason: 'FORBIDDEN_CHILD'`. Other files in the root level still enumerate.

- **Pagination**
  - 120 supported files split across two `nextPageToken` pages → all 120 considered; first 50 alphabetically end up in `files`, remaining 70 in `rejected[]` with `TOO_MANY_FILES`

- **Token acquisition**
  - Each top-level call invokes `ensureFreshAccessToken(userId)` exactly once at the start (subsequent paginated list calls reuse the token from the same Authorization header — no need to refresh per page).

## Verification gate (all must pass)

- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32) npx vitest run __tests__/lib/google/drive.test.ts`
- Full suite: `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — partial responsibility

- **AC-9 (TRASHED)** — error class raised; routing in Task 08
- **AC-10 (FORBIDDEN)** — error class raised; routing in Task 08
- **AC-7 (folder expansion mechanics)** — enumeration mechanics; row creation in Task 08
- **AC-8 (folder cap)** — enumeration mechanics; HTTP 422 in Task 08

## Out of scope

- Creating Artifact rows from results — Task 08
- Mapping these errors to HTTP status codes — Task 08
- The folder Artifact's own row — Task 08

## Done when

- `drive.ts` implements the three public functions with the exact signatures above.
- All tests pass.
- No imports of `googleapis` SDK anywhere in the repo (`grep -r googleapis src/` returns nothing).
- Single commit on `feat/m4-02-drive`.

## Escalate if

- A real Drive response shape diverges from what's documented above (e.g. `size` is a number not a string) — capture the actual contract from Drive docs before adapting tests.
- Drive's `orderBy=name` returns case-sensitive ordering that surprises AC-8 — escalate; spec wording is "first 50 by name" and we want it deterministic.
