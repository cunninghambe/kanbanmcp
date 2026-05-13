# Task 04 — Artifacts API + storage abstraction

**Agent type:** coder
**Depends on:** 01-schema
**Spec sections:** §4.4 (Artifacts), §7 AC-5, §6 E10/E11/E14, §8 row 7 (Storage)

---

## Goal

Build the artifact upload, list, download, and delete endpoints, plus a storage abstraction with a local-disk driver (M1) and a typed seam for the S3 driver to slot in later. No AI review is triggered in this task — the upload handler emits an event the next task consumes. The MIME allowlist, size cap, path-traversal hardening, and uploader/admin delete authorisation all live here.

## Inputs — files to read first

- `/root/kanbanmcp/src/app/api/cards/[cardId]/route.ts` — auth pattern (`resolveCard`)
- `/root/kanbanmcp/src/app/api/cards/[cardId]/comments/` (if it exists) — pattern for nested-card routes; otherwise mirror the cards route
- `/root/kanbanmcp/src/lib/api-helpers.ts` — `requireSession`, `requireOrgRole`, `apiError`
- `/root/kanbanmcp/prisma/schema.prisma` post Task 01 — `Artifact` model
- M1 spec §4.4, §7 AC-5, §6 E10/E11/E14, §8 row 7
- **Audit assumption 9:** on-disk filename is the artifact's cuid `id`. Original filename is in DB only. Prevents path traversal entirely.

## Files to create / modify

**Create:**

- `/root/kanbanmcp/src/lib/storage.ts` — storage driver abstraction + local driver. S3 stub returns "not implemented" in M1 unless `STORAGE_DRIVER=s3` is set and `@aws-sdk/client-s3` is installed (do NOT install the package in this task; emit a clear runtime error if requested without it).
- `/root/kanbanmcp/src/app/api/cards/[cardId]/artifacts/route.ts` — POST (upload), GET (list)
- `/root/kanbanmcp/src/app/api/artifacts/[artifactId]/route.ts` — DELETE
- `/root/kanbanmcp/src/app/api/artifacts/[artifactId]/download/route.ts` — GET stream
- `/root/kanbanmcp/src/lib/artifacts.ts` — shared helpers: MIME allowlist, size cap constants, `resolveArtifactWithCard(artifactId, orgId)`, response shaping (`shapeArtifact`)

## Interface contract

### `src/lib/storage.ts`

```ts
import type { Readable } from 'node:stream'

export interface StorageDriver {
  /** Persist the bytes and return the canonical storage key (e.g. the path or S3 key). */
  put(key: string, bytes: Buffer, contentType: string): Promise<{ key: string }>
  /** Read the bytes back as a stream. */
  getStream(key: string): Promise<Readable>
  /** Delete the underlying object. Idempotent — missing object is not an error. */
  delete(key: string): Promise<void>
}

/** Returns the configured driver. Reads env: STORAGE_DRIVER, STORAGE_DIR, S3_BUCKET. */
export function getStorageDriver(): StorageDriver
```

Local driver:

- Base directory: `process.env.STORAGE_DIR || './uploads'` (resolved to absolute via `path.resolve`)
- `put(key, bytes)` writes to `<baseDir>/<key>` with permissions 0640, creating the directory if needed.
- `getStream(key)` returns `fs.createReadStream(<baseDir>/<key>)`.
- `delete(key)` calls `fs.promises.unlink`, swallowing `ENOENT`.
- Reject any `key` containing `/`, `\`, `..`, or null bytes — throw `Error('Invalid storage key')`. The Artifact route is responsible for using the artifact's cuid as the key; the driver enforces it defensively.

S3 driver (in M1 — stub):

- If `STORAGE_DRIVER === 's3'`, attempt `require('@aws-sdk/client-s3')`. If module missing, throw `Error('S3 driver requires @aws-sdk/client-s3 (not installed in M1)')`. **Do not install the package in this task.**
- Implementation can be a thin pass-through if the import works, but the test path is local-only.

### `src/lib/artifacts.ts`

```ts
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024 // 25 MB

export const ALLOWED_MIME_TYPES: ReadonlyArray<string> = [
  'application/pdf',
  'application/json',
  'application/x-yaml',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/webp',
]
// "text/*" allowlist — checked separately via prefix match.

export function isAllowedMime(mime: string): boolean {
  if (mime.startsWith('text/')) return true
  return ALLOWED_MIME_TYPES.includes(mime)
}

export function shapeArtifact(
  a: Artifact & { uploader: User; reviews: AiReview[] }
): ArtifactResponse
```

### Upload endpoint: `POST /api/cards/[cardId]/artifacts`

- Auth: `requireSession`, `resolveCard`, `requireOrgRole(MEMBER)`.
- **API-key auth case:** the uploader's `userId` cannot be the session user (no real user). Resolve via the same fallback as `boards/[boardId]/cards`: pick the first org admin. Persist as `uploaderId`.
- Request: `multipart/form-data` with field `file`. Use `req.formData()` (Next.js 14 supports this on `NextRequest`).
- Validation order:
  1. Field `file` exists and is a `File` (or `Blob` with a name) → else 400 "Missing file field".
  2. `file.size` ≤ `MAX_ARTIFACT_BYTES` → else 413 "Payload Too Large" (AC E11). Spec calls for 413; use `apiError(413, ...)`.
  3. `isAllowedMime(file.type)` → else 415 "Unsupported Media Type" (AC E10).
- Generate the artifact ID first (use `cuid` via `@paralleldrive/cuid2` — wait, we don't have it; use Prisma's default by computing once via the schema. Actually: use the same approach as the existing code — let Prisma generate during `create`. **Workflow:** `create` the row to get the id; THEN write the bytes using the id as the storage key; THEN if the write fails, `delete` the row to roll back. This avoids needing a separate cuid generator.

  Cleaner alternative: import `cuid` library. The project does not yet have it as a direct dependency, but `@prisma/client` ships with one. Avoid using internal Prisma exports. Use the create-then-write-then-rollback pattern.

- Persist as `Artifact { cardId, uploaderId, filename: file.name, mimeType: file.type, sizeBytes: file.size, storageKey: <id>, source: 'UPLOAD' }`.
- Call `storage.put(artifact.id, Buffer.from(await file.arrayBuffer()), file.type)`. If it throws, `prisma.artifact.delete` the row and return 500.
- **Emit auto-review trigger.** Re-fetch the parent card and check `card.aiAutoReview`. If true, call `enqueueAiReview(artifact.id)` from `src/lib/ai-review/queue.ts` — **but Task 05 owns that module.** For now in Task 04, define a stub interface and import lazily:
  ```ts
  // Lazy require to avoid coupling. Task 05 fills this in.
  import { enqueueAiReview } from '@/lib/ai-review/queue'
  // Stub for Task 04: if Task 05 isn't merged yet, export a no-op from queue.ts
  ```
  **For this task's PR**, create `/root/kanbanmcp/src/lib/ai-review/queue.ts` with a no-op stub:
  ```ts
  export async function enqueueAiReview(artifactId: string): Promise<void> {
    console.log('[ai-review-stub] enqueueAiReview', artifactId)
  }
  ```
  Task 05 will replace the implementation.
- Response: status 201, body `{ artifact: <ArtifactResponse> }`.

### List endpoint: `GET /api/cards/[cardId]/artifacts`

- Auth: same.
- Returns `{ artifacts: ArtifactResponse[] }`, ordered `createdAt DESC`.
- Include `uploader` (id, email, name) and `reviews` (the AiReview rows; see Task 05 for shape — for now include `id, status, createdAt, finishedAt`).

### Download endpoint: `GET /api/artifacts/[artifactId]/download`

- Auth: `requireSession`, resolve artifact via `prisma.artifact.findUnique({ include: { card: { include: { board: { select: { orgId: true } } } } } })`. 404 if missing; 403 if `artifact.card.board.orgId !== session.orgId`. Then `requireOrgRole(MEMBER)`.
- Stream the file via `storage.getStream(artifact.storageKey)` wrapped in a `Response` body. Set headers: `Content-Type: <artifact.mimeType>`, `Content-Disposition: attachment; filename="<sanitisedFilename>"` (escape quotes, strip control chars), `Content-Length: <sizeBytes>`.
- On `ENOENT` from storage → 410 "Gone" (file missing but row exists — surface this clearly).

### Delete endpoint: `DELETE /api/artifacts/[artifactId]`

- Auth: same resolve pattern. Then:
  - Allow if `session.userId === artifact.uploaderId`, OR
  - Allow if the requesting user is an `ADMIN` in `session.orgId` (`requireOrgRole(session, session.orgId, 'ADMIN')` succeeding without throwing) — call it inside a try/catch; if throws, fall through to 403.
  - Otherwise 403 "Only the uploader or an org admin may delete this artifact".
- Operation order:
  1. `prisma.$transaction(async tx => { await tx.aiReview.deleteMany({ where: { artifactId } }); await tx.artifact.delete({ where: { id } }) })`
     - Cascade already does both, but explicit transaction lets us guarantee atomicity vs storage.
  2. After commit: `storage.delete(artifact.storageKey)`. If this fails, log but return 204 success (DB is the source of truth).
- Response: 204 No Content.

### Response shape

```ts
interface ArtifactResponse {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  source: string
  createdAt: string // ISO
  uploader: { id: string; name: string; email: string }
  reviews: AiReviewSummary[]
}

interface AiReviewSummary {
  id: string
  status: string
  model: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}
```

## Implementation notes

1. **`formData()` on `NextRequest`.** Next 14 supports `await req.formData()`. The `File` object has `.name`, `.type`, `.size`, `.arrayBuffer()`. There is no streaming upload in M1 — buffer everything; the 25 MB cap makes this safe.
2. **Path traversal hardening.** Three layers: (a) storage key = artifact cuid (no user input); (b) storage driver rejects keys with `/`, `\`, `..`, `\0`; (c) download `Content-Disposition` quotes and strips control chars in `filename`. Do not trust `file.name` for any filesystem operation.
3. **MIME from `file.type` is client-supplied** — a malicious client could lie. M1 trusts it (spec §4.4 specifies the allowlist on `file.type`). Document this in a code comment. A future hardening step would use `file-type` to sniff content; out of scope.
4. **API-key uploader resolution.** Mirror the pattern in `boards/[boardId]/cards/route.ts` for picking the first org admin. Do not invent a new approach.
5. **`enqueueAiReview` stub in this task.** Create the module so Task 04 has something to call; Task 05 swaps in the real implementation. Both tasks should produce non-conflicting diffs against `src/lib/ai-review/queue.ts`.
6. **Test environment storage dir.** Tests set `STORAGE_DIR=./uploads-test` (or use `os.tmpdir()`). Mock `storage.put`/`storage.getStream`/`storage.delete` via `vi.mock('@/lib/storage')` to avoid touching disk during unit tests. One integration test that exercises the real local driver against a temp dir is acceptable.
7. **Existing `npm test` env vars.** `SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db`. Storage tests must not require a different env — they should either mock the driver or use `os.tmpdir()` programmatically.
8. **DB-storage atomicity caveat.** True atomicity between SQL and the filesystem is not possible. The create-then-write-then-rollback pattern is good enough; if rollback fails, log loudly. Document this with a comment.
9. **Streamed download `Response` body.** In Next 14 you can pass a `ReadableStream` to `new Response(stream)`. Convert the Node `Readable` to a Web `ReadableStream` via `Readable.toWeb(stream) as ReadableStream`. Set `headers` on the `Response` constructor options.

## Acceptance criteria

- **AC-5:** `POST /api/cards/X/artifacts` with a PDF under 25 MB stores the file under `<STORAGE_DIR>/<artifactId>`, returns 201 with the artifact body, including `uploader` and an empty `reviews` array.
- **E10:** Uploading `application/zip` returns 415.
- **E11:** Uploading a 26 MB file returns 413.
- Uploading without the `file` field returns 400 "Missing file field".
- **List:** `GET /api/cards/X/artifacts` returns artifacts for that card, newest first.
- **Download:** `GET /api/artifacts/X/download` streams the bytes with `Content-Type` and `Content-Disposition` headers.
- **Delete authz:** uploader can delete; admin can delete; another non-uploader member cannot (403).
- **Delete:** removes the DB row and the underlying file.
- **Delete with missing file:** still removes the row and returns 204 (storage delete is best-effort).
- **Auto-review trigger placeholder:** `enqueueAiReview` is invoked when `card.aiAutoReview === true`. The stub does nothing observable in this task; Task 05 verifies the real behaviour.
- `npx tsc --noEmit` passes.

## Tests to write

- `/root/kanbanmcp/__tests__/api/artifacts-upload.test.ts`
  - Allowed MIME, success path, returns 201, body shape
  - 415 for disallowed MIME
  - 413 for oversize
  - 400 for missing `file`
  - `enqueueAiReview` called when `card.aiAutoReview === true`; not called when false
  - Storage failure → row rolled back, 500 returned
- `/root/kanbanmcp/__tests__/api/artifacts-list.test.ts`
  - Ordering, response shape
- `/root/kanbanmcp/__tests__/api/artifacts-download.test.ts`
  - Streams bytes; auth check; 410 when file missing
- `/root/kanbanmcp/__tests__/api/artifacts-delete.test.ts`
  - Uploader allowed, admin allowed, other member denied
  - Storage delete failure does not fail the request
- `/root/kanbanmcp/__tests__/lib/storage.test.ts`
  - Local driver round-trips bytes under `os.tmpdir()`
  - Rejects keys with `/`, `\`, `..`, `\0`
  - Idempotent delete (no error on ENOENT)
- `/root/kanbanmcp/__tests__/lib/artifacts.test.ts`
  - `isAllowedMime` table-driven
  - `shapeArtifact` produces the documented response shape

Mock `@/lib/db` per existing pattern. Use `vi.mock('@/lib/storage')` for route tests; use `os.tmpdir()` in `storage.test.ts`.

## Out of scope for this task

- Real AI review worker — only the no-op stub for `enqueueAiReview` (Task 05 owns the implementation)
- S3 driver implementation (just the stub error path)
- Re-review endpoint `POST /api/artifacts/[id]/reviews` (Task 05)
- MCP `list_artifacts` tool (Task 07)
- Any UI (Task 08)
- Server-side virus scanning, content sniffing, EXIF stripping

## Done when

- All endpoints exist and pass tests.
- Storage driver round-trips correctly on local disk.
- `enqueueAiReview` stub exists at `src/lib/ai-review/queue.ts`.
- `npx tsc --noEmit` passes.
- Single commit on `feat/m1-review-workflow`.
