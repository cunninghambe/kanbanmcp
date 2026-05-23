# Task 04 — Extractor `multimodal` variant + `extractContent` dispatch on `artifact.source` + Claude multimodal call

**Agent type:** coder
**Depends on:** 00-schema, 01-oauth, 02-drive, 03-exporters
**Spec sections:** M4 spec — "Extension to src/lib/ai-review/extractors.ts" block, `claude-client.ts` multimodal extension, AC-4, AC-5, AC-6

---

## Goal

Extend `ExtractedContent` with a third `multimodal` variant. Make `extractContent` dispatch on `artifact.source` BEFORE its current MIME sniffing. Extend `claude-client.ts` to build interleaved text + image content blocks when receiving a `multimodal` payload. After this task, an Artifact with `source='GOOGLE_DOC|SHEET|SLIDE'` flows through the existing M1 review worker with no further changes to `worker.ts`.

## Inputs — files to read first

- `/opt/kanban/src/lib/ai-review/extractors.ts` — current signature is `extractContent(bytes, mimeType, filename)`. M4 needs the full Artifact row for the source check. We are widening the signature.
- `/opt/kanban/src/lib/ai-review/worker.ts` — see how `extractContent` is invoked; you'll update the call site.
- `/opt/kanban/src/lib/ai-review/claude-client.ts` — current text + image branches; add a multimodal branch.
- `/opt/kanban/src/lib/google/docs.ts`, `sheets.ts`, `slides.ts` — exporters from Task 03
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — extractor block, multimodal Anthropic call shape, AC-4 / 5 / 6

## Files to create / modify

**Modify:**

- `/opt/kanban/src/lib/ai-review/extractors.ts`
  - Widen `ExtractedContent` to include the multimodal variant
  - Change `extractContent` signature (see contract). Update the discriminated union to support `kind: 'multimodal'`
  - Add dispatch on `artifact.source` before the existing MIME sniffing
- `/opt/kanban/src/lib/ai-review/claude-client.ts`
  - Add a `buildMultimodalUserMessage` helper
  - Add the new branch to `buildUserMessage`
- `/opt/kanban/src/lib/ai-review/worker.ts`
  - Update the call site to pass the artifact (not just bytes/mime/filename). For `UPLOAD` source, the worker still fetches bytes via storage and the extractor still text/image-decodes those. For `GOOGLE_*` source, the worker calls `extractContent({ artifact })` with no bytes — the extractor calls the exporters internally.

**Create:**

- `/opt/kanban/__tests__/lib/ai-review/extractors-multimodal.test.ts`
- `/opt/kanban/__tests__/lib/ai-review/claude-multimodal.test.ts`

**Do NOT** create new files outside what's listed.

## Interface contract

### Extended `ExtractedContent`

```ts
export type ExtractedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; imageBase64: string; imageMimeType: 'image/png' | 'image/jpeg' | 'image/webp' }

export type ExtractedContent =
  | { kind: 'text';  text: string }
  | { kind: 'image'; imageBase64: string; imageMimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { kind: 'multimodal'; segments: ExtractedSegment[] }
  | { kind: 'empty' }
```

Note: this widens the existing union — coder must update all existing destructurings in the worker / claude-client (compile errors will catch them).

### New `extractContent` signature

```ts
// Replaces the old (bytes, mimeType, filename) signature.
export interface ExtractContentInput {
  artifact: {
    id: string
    source: string             // 'UPLOAD' | 'GOOGLE_DOC' | 'GOOGLE_SHEET' | 'GOOGLE_SLIDE' | 'GOOGLE_FOLDER' | 'URL'
    storageKey: string         // for UPLOAD this is the storage path; for GOOGLE_* it is 'gdrive://<fileId>'
    mimeType: string
    filename: string
    uploaderId: string         // the user whose Google credentials gate access
  }
  bytes?: Buffer               // present only when caller already has the buffer (legacy UPLOAD path)
}

export async function extractContent(input: ExtractContentInput): Promise<ExtractedContent>
```

Dispatch order:

1. If `artifact.source === 'GOOGLE_DOC'` →
   `{ kind: 'text', text: await exportDocAsMarkdown(uploaderId, fileIdFromStorageKey(artifact.storageKey)) }`
2. If `artifact.source === 'GOOGLE_SHEET'` →
   `{ kind: 'text', text: await exportSheetAsCsv(uploaderId, fileId) }`
3. If `artifact.source === 'GOOGLE_SLIDE'` →
   Call `extractSlides(uploaderId, fileId)`. Build `segments` as:
   ```
   for each SlideContent in result:
     push { kind: 'text', text: `## Slide ${slideIndex}\n\n${text}` }
     for each imageDataUrl: push { kind: 'image', imageBase64, imageMimeType: 'image/png' }
   ```
   Return `{ kind: 'multimodal', segments }`. If `segments` is empty (deck with no text/images), return `{ kind: 'empty' }`.
4. If `artifact.source === 'GOOGLE_FOLDER'` →
   Throw `Error('GOOGLE_FOLDER is not reviewable — folders expand to file artifacts at attach time')`. This is an invariant; the worker should never call extractContent on a folder.
5. If `artifact.source === 'URL'` →
   Return `{ kind: 'empty' }` for now (URL artifacts are out of M4 scope per spec; reserved for future).
6. Otherwise (`UPLOAD` or unknown):
   Existing MIME-based logic. If `bytes` is missing, throw `Error('UPLOAD source requires bytes')`. Otherwise behave exactly as the legacy `extractContent(bytes, mimeType, filename)` did.

**Helper:**

```ts
export function fileIdFromStorageKey(storageKey: string): string
// 'gdrive://<id>'           → '<id>'  (file)
// 'gdrive://folder/<id>'    → throws (folder not extractable)
// anything else             → throws Error('Invalid Google storageKey: <key>')
```

### `claude-client.ts` multimodal branch

```ts
function buildMultimodalUserMessage(
  segments: ExtractedSegment[],
  filename: string
): Anthropic.Messages.MessageParam {
  // Interleave: each text segment becomes a { type: 'text', text } block;
  // each image segment becomes a { type: 'image', source: { type: 'base64', media_type, data } } block.
  // Prepend a single leading text block:
  //   `Review this artifact (filename: ${filename}). The artifact contains interleaved text and images.`
  // Return { role: 'user', content: [<leading>, ...segments mapped] }
}
```

Update `buildUserMessage(content, filename)`:

- if `content.kind === 'multimodal'` → use the helper above
- existing `image` + `text` branches unchanged

### Worker call site

Replace:

```ts
const content = await extractContent(bytes, artifact.mimeType, artifact.filename)
```

With:

```ts
const content =
  artifact.source === 'UPLOAD'
    ? await extractContent({ artifact: { ...artifact, uploaderId: artifact.uploaderId }, bytes })
    : await extractContent({ artifact: { ...artifact, uploaderId: artifact.uploaderId } })
```

For Google sources, **do not** read storage (skip the `storage.getStream` call). Bytes are not in our storage.

### ClaudeMCP routing (carry-through from spec § "ClaudeMCP routing")

Per spec: text-only Google content (Docs, Sheets) routes through `runViaClaudeMCP` if configured; multimodal (Slides) routes through `runViaAnthropic` because ClaudeMCP can't carry image payloads. The existing routing logic in `claude-client.ts` already dispatches on content shape — confirm the multimodal path takes the Anthropic branch unconditionally and add a test for it.

## Hard rules

1. **No new files** outside the ones listed (one test file is allowed split into two for clarity; both listed).
2. **Do NOT modify `worker.ts` beyond the single call-site change.** No new statuses, no new branches.
3. **Discriminated unions only** — no string-typed source dispatch outside the extractor. Use a switch with exhaustiveness check (`const _exhaustive: never = ...`).
4. Functions ≤ 40 lines.
5. **No `any`.** Anthropic SDK's `MessageParam` is fully typed; respect it.
6. Existing `UPLOAD` behaviour must remain bit-identical. Existing extractor tests must still pass without modification (except possibly updating the call shape — if so, update the smallest possible number of lines in existing tests).
7. **GOOGLE_FOLDER must throw** if it ever reaches `extractContent`. This is an invariant assertion, not an error to handle.
8. Multimodal `claude-client` branch sends to `runViaAnthropic` only; never to ClaudeMCP. Add a code comment citing the spec section.

## Tests to write

### `extractors-multimodal.test.ts`

- **GOOGLE_DOC dispatch** (AC-4): stub `exportDocAsMarkdown` via `vi.mock('@/lib/google/docs', ...)`. Artifact with `source='GOOGLE_DOC'`, `storageKey='gdrive://X'`. Expect `{ kind: 'text', text: '<mock markdown>' }`. The mock asserts it was called with `(uploaderId, 'X')`.
- **GOOGLE_SHEET dispatch** (AC-5): same pattern; verify `exportSheetAsCsv` called with the right ids.
- **GOOGLE_SLIDE dispatch** (AC-6): stub `extractSlides` to return 2 slides, slide 1 has text + 1 image, slide 2 has text only. Assert `kind === 'multimodal'`, segments alternate correctly: `[text("## Slide 1\n\n…"), image, text("## Slide 2\n\n…")]`. Slide 2 has no image segment.
- **GOOGLE_SLIDE empty deck** → `{ kind: 'empty' }`
- **GOOGLE_FOLDER throws** with the specific error message
- **URL → empty**
- **UPLOAD path unchanged**: an artifact with `source='UPLOAD'`, `mimeType='text/plain'`, `bytes=Buffer.from('hello')` returns `{ kind: 'text', text: 'hello' }` — confirms the legacy behaviour is preserved
- **UPLOAD without bytes throws**
- **fileIdFromStorageKey** unit tests: file, folder (throws), invalid (throws)

### `claude-multimodal.test.ts`

- **buildUserMessage on multimodal** produces a content array of the right shape: leading text + interleaved blocks; image blocks use base64 source type and the correct media_type
- **Empty segments array** routed through buildUserMessage is rejected (we should never reach this — extractor returns `empty` instead — but assert defensive behaviour)
- **runClaudeReview with multimodal content** (mocking `@anthropic-ai/sdk`): assert the SDK's `messages.create` was called with a `messages[0].content` array containing image blocks
- **ClaudeMCP routing bypassed for multimodal**: with `CLAUDEMCP_URL` and `CLAUDEMCP_PROJECT` set in the env, multimodal still routes to the Anthropic path. Use the existing routing-test helpers if any; otherwise stub the MCP helper and assert it's not called when content is multimodal.

## Verification gate (all must pass)

- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32) npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — full responsibility

- **AC-4** (Doc review: extracted markdown is what got sent to Claude)
- **AC-5** (Sheet review: cell values reach the Claude payload)
- **AC-6** (Slides multimodal: text + image content both in Claude payload)

## Out of scope

- Creating Artifact rows with `source='GOOGLE_*'` — Task 08
- OAuth lifecycle UI — Tasks 07/09
- Rate-limiter wrapping the exporter calls — Task 11

## Done when

- `ExtractedContent` widened; `extractContent` rewired around the new input shape.
- `claude-client.ts` builds multimodal content arrays correctly.
- `worker.ts` call site updated (single-line change minus the import).
- All existing M1 review tests still pass (this is the key regression bar).
- New tests pass.
- Single commit on `feat/m4-04-extractor-multimodal`.

## Escalate if

- Anthropic SDK rejects multimodal content with an unfamiliar 400 — capture the body before adapting tests.
- The existing extractor has callers outside `worker.ts` that the signature change breaks unexpectedly — flag the call sites; do not silently patch them.
