# Task 03 — Google export modules: `docs.ts`, `sheets.ts`, `slides.ts`

**Agent type:** coder
**Depends on:** 00-schema, 01-oauth, 02-drive
**Spec sections:** M4 spec — docs.ts / sheets.ts / slides.ts contract blocks, E13 (slides image cap), E14 (sheet truncation)

---

## Goal

Implement the three Google-content exporters. All are thin: each takes `(userId, fileId)`, acquires a token via the OAuth module, calls one or two Google endpoints, and returns deterministic text or structured slide segments. The three live in separate files for clarity but are decomposed as one task because each is ~50 LOC and the test surface is unified.

**Decomposition note (from architect):** Spec lists these as three tasks (03, 04, 05). Merged into one because:
1. Each individual exporter is <80 LOC and tested in isolation
2. They share zero state with each other but share the same fetch-stub fixture pattern
3. Three separate PRs would each have identical scaffolding overhead

If the coder finds the file growing past 250 LOC of test setup, split — the file structure is still 3 source files, only the test file is unified.

## Inputs — files to read first

- `/opt/kanban/src/lib/google/oauth.ts` — `ensureFreshAccessToken`
- `/opt/kanban/src/lib/google/fetch.ts` — `googleFetch`
- `/opt/kanban/src/lib/google/drive.ts` — to understand the existing call shape (Authorization, supportsAllDrives)
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — docs.ts / sheets.ts / slides.ts blocks + E13, E14

## Files to create / modify

**Create:**

- `/opt/kanban/src/lib/google/docs.ts`
- `/opt/kanban/src/lib/google/sheets.ts`
- `/opt/kanban/src/lib/google/slides.ts`
- `/opt/kanban/__tests__/lib/google/exporters.test.ts`

**Do NOT modify** drive.ts, oauth.ts, or any extractor in this task. Extractor wiring lands in Task 04.

## Interface contract

### `src/lib/google/docs.ts`

```ts
export async function exportDocAsMarkdown(userId: string, fileId: string): Promise<string>
// GET https://www.googleapis.com/drive/v3/files/<id>/export?mimeType=text%2Fmarkdown
// Authorization: Bearer <ensureFreshAccessToken(userId)>
// Returns the response body as a string.
// On 404 → DriveNotFoundError
// On 403 → DriveForbiddenError
// On 5xx → GoogleHttpError
```

### `src/lib/google/sheets.ts`

```ts
export const SHEETS_MAX_ROWS = 100
export const SHEETS_MAX_COLS = 26  // A..Z

export async function exportSheetAsCsv(userId: string, fileId: string): Promise<string>
// Algorithm:
// 1. GET https://sheets.googleapis.com/v4/spreadsheets/<id>?fields=sheets.properties(title,gridProperties)
//    to enumerate tab names + dimensions
// 2. For each sheet, GET https://sheets.googleapis.com/v4/spreadsheets/<id>/values/<encoded-title>?majorDimension=ROWS
//    Truncate to SHEETS_MAX_ROWS × SHEETS_MAX_COLS per tab. If the sheet has more rows, append
//    a synthetic last row exactly: `... (N rows truncated)` where N = totalRows - SHEETS_MAX_ROWS.
//    Extra columns beyond SHEETS_MAX_COLS are silently dropped (cell content not truncated).
// 3. Concatenate per spec format:
//    `## Sheet: <name>\n<csv>\n\n## Sheet: <name>\n<csv>\n...`
//    where `<csv>` is RFC-4180-style: fields with comma, newline, or quote are
//    double-quoted with internal quotes doubled.
// Errors propagate the same way as docs.ts.
```

### `src/lib/google/slides.ts`

```ts
export const SLIDES_IMAGES_PER_SLIDE_CAP = 5

export interface SlideContent {
  slideIndex: number       // 1-based for display
  text: string             // concatenated text frame contents
  imageDataUrls: string[]  // base64 PNG, no `data:` prefix; up to SLIDES_IMAGES_PER_SLIDE_CAP entries
}

export async function extractSlides(userId: string, fileId: string): Promise<SlideContent[]>
// 1. GET https://slides.googleapis.com/v1/presentations/<id>
//    Returns { slides: [{ objectId, pageElements: [...] }] }
// 2. For each slide:
//    - text: walk pageElements, find shapes with `shape.text.textElements[*].textRun.content`,
//      join in document order with single newline separators. Trim trailing whitespace.
//    - images: pageElements with `image.contentUrl` (signed Google URL). Fetch up to
//      SLIDES_IMAGES_PER_SLIDE_CAP per slide IN ORDER OF APPEARANCE; for each, GET the contentUrl
//      with the same Bearer token, capture body bytes, encode base64. Drop images that 404.
//      If a slide has > SLIDES_IMAGES_PER_SLIDE_CAP images, append exactly this string to the
//      slide's text (newline-separated): `[N additional images not included]` where N = total - cap.
//    - slideIndex is 1-based by position in the slides[] array
```

## Hard rules

1. **No `googleapis` SDK.** All HTTP via `googleFetch`.
2. **No new crypto / no env leakage.** Reuse the OAuth module for tokens.
3. **No silent error swallowing.** Permanent (4xx) errors throw typed errors from `errors.ts`. Transient (5xx) errors throw `GoogleHttpError` and the caller (extractor / worker) handles retry. Empty response bodies are valid (empty doc) → return `''`.
4. Functions ≤ 40 lines each. Pure helpers (csv quoting, slide-text walker) factored out and unit-tested separately.
5. **Image fetches** use the same `googleFetch` wrapper. Tests stub them. Slide image bytes are read as `arrayBuffer()` not `text()` — add the method to `googleFetch`'s response type if absent (this is the only structural change to fetch.ts; flag in PR if needed).
6. **No `any`.** Slide / Sheets response shapes declared as TypeScript types or Zod schemas in the same file.
7. `SHEETS_MAX_ROWS` and `SHEETS_MAX_COLS` and `SLIDES_IMAGES_PER_SLIDE_CAP` are exported constants for tests.

## Tests to write

`/opt/kanban/__tests__/lib/google/exporters.test.ts` — three describe blocks, one per module. Stub `googleFetch` per case.

### Docs
- Happy path: stub returns `'# Hello\n\nWorld'` → resolves to that string
- 404 → `DriveNotFoundError`
- 403 → `DriveForbiddenError`
- 500 → `GoogleHttpError(500, ...)`
- Empty body → `''`

### Sheets (E14)
- Single tab "Sheet1", 3 rows × 3 cols → CSV with header `## Sheet: Sheet1\n` + 3 lines
- Two tabs "Tab A", "Tab B" → concatenation with `\n\n` between
- **E14:** Sheet with 150 rows → output contains rows 1..100 then `... (50 rows truncated)` (verify exact wording)
- **E14:** Sheet with 30 columns → only A..Z emitted; no extra-column annotation in CSV
- CSV quoting: a cell with `Hello, "world"` → `"Hello, ""world"""` in output
- Tab title with `/` or `'` → URL-encoded in the values fetch (test asserts the constructed URL)

### Slides (E13)
- Slide with two text shapes + zero images → `SlideContent[0].text` is both texts joined by `\n`, `imageDataUrls === []`
- Slide with one image: stub the contentUrl fetch to return 3 raw bytes; output `imageDataUrls[0]` is the correct base64
- **E13:** Slide with 7 images → first 5 captured; slide.text ends with `[2 additional images not included]`
- Image fetch returns 404 mid-slide → skipped silently; remaining images included; no error thrown
- Presentation with 3 slides → output length 3, slideIndex values 1, 2, 3
- Token-refresh integration: stub `ensureFreshAccessToken` to track calls; assert exactly one call per top-level `extractSlides` invocation regardless of number of image fetches

## Verification gate (all must pass)

- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32) npx vitest run __tests__/lib/google/exporters.test.ts`
- Full suite: `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — partial responsibility

- **AC-4** (Doc review end-to-end) — markdown export step
- **AC-5** (Sheet review end-to-end) — CSV export step, including cell value preservation
- **AC-6** (Slides multimodal) — slide content extraction including images; multimodal Claude call lives in Task 04

## Out of scope

- Hooking these into `extractContent` — Task 04
- Multimodal Claude call shape — Task 04
- Rate-limiter integration — Task 11

## Done when

- All three modules implemented with the exact signatures.
- All exporter tests pass.
- Single commit on `feat/m4-03-exporters`.

## Escalate if

- Drive's export endpoint returns 400 for Google Docs without an `Accept-Charset` header (real-world quirk) — capture once observed
- A Slides image is hosted on a non-`googleusercontent.com` URL — the spec assumes Bearer auth works; if Google starts returning signed URLs that 401 with Authorization, fall back to fetching without the header (note in code + test)
