# M3: Deliverable files + pre-commit review gate

## Status
Spec, drafted 2026-05-20. Awaiting Brad's final go.

## Problem statement

M2 ships card output as a long inline comment. That works for narrow tasks but doesn't scale: the actual work product (content plan, financial spreadsheet, slide deck) belongs in a file the user can open and share, not buried in markdown inside a comment thread. Today's Healthyspoon card shipped its 320-line content plan as a single committed `.md` file but a human reading the kanban card has no easy way to download/view it — they have to git-checkout the agent branch.

M3 closes that loop:

1. Claude is instructed to produce a deliverable file (or files) in formats appropriate to the task (md/html/docx/xlsx/pptx).
2. Before committing, Claude spawns a reviewer subagent that critiques the deliverable against the spec. Reviewer issues PASS/REVISE. On REVISE, Claude revises (or reverts and re-attempts), up to N rounds.
3. After commit, the kanban worker reads the deliverable file(s) from the agent branch, copies them into kanban's `uploads/` storage, attaches them as `artifacts` on the card. The summary line goes in the card comment; the full output does not.

## Boundaries

### In scope
- Enriched spec text prepended in the kanban worker before submitting `claude_build` (no ClaudeMCP fork required)
- Standard deliverable directory `/deliverables/<name>.<ext>` on the agent branch
- Output protocol: terminal lines `DELIVERABLES: <comma-separated paths>` + `SUMMARY: <≤300 words>` before the existing `FINAL COMMIT:` line
- Pre-commit reviewer subagent loop, max 3 rounds, capped via `--max-thinking-tokens` and explicit prompt instructions
- Library auto-install via uv-managed `.venv-agent/` (or per-project requirements) when docx/xlsx/pptx is the chosen format
- Default `runTests: false` for `claude_build` calls from kanban M3 (per Brad: most tasks aren't code)
- Worker post-job logic: parse `DELIVERABLES:` line, read file(s) from agent branch via path lookup in `/root/ClaudeMCP/projects.json`, copy to kanban `uploads/`, insert `artifacts` row(s)
- Comment posted on card = `SUMMARY:` content (≤300 words), NOT the full output
- Graceful fallback: if Claude forgets `DELIVERABLES:` or `SUMMARY:`, post the raw output as comment (M2 behavior) and surface a warning comment

### Out of scope
- Per-card override of `runTests` (defer; can be added if a real code-task card needs it)
- Real-time progress streaming during the long pre-commit review loop (worker still polls every 5s; user just sees "Claude is now running" until done)
- UI changes beyond what artifacts already render (M1 already shows artifacts on cards; the new attachments will appear there automatically)
- ClaudeMCP changes — all instructions injected via the `spec` field
- File type validation/scan beyond what the existing artifact upload path already does
- Reviewer-loop transcript surfaced as a comment (the final summary suffices; intermediate reviewer rounds stay inside Claude's process logs)

## Interface contract

### Enriched spec text (kanban → ClaudeMCP)

The kanban worker constructs the `spec` argument to `submitClaudeBuild` as the concatenation of:

```
${card.title}

${card.description}

---
DELIVERABLE REQUIREMENTS

This task is the work product, not the code. Produce one or more deliverable
files in the format(s) most appropriate to the task:

- markdown (.md): plans, research, strategy, write-ups
- html (.html): web content, landing pages
- xlsx (.xlsx): data, models, financial work — use openpyxl
- pptx (.pptx): slide decks — use python-pptx
- docx (.docx): formatted documents, contracts — use python-docx
- csv (.csv): tabular data
- json (.json): structured machine-readable output

Write every deliverable into the `/deliverables/` directory at the repo root.
Use descriptive kebab-case filenames. Multiple deliverables are allowed when
the task naturally produces several artifacts (e.g., model + slides + summary).

If you need Python libraries for binary formats, install them into a venv at
`.venv-agent/` at the repo root: `uv venv .venv-agent && uv pip install --python .venv-agent/bin/python python-docx openpyxl python-pptx`.
Do not commit the venv. Do not modify the project's existing Python or Node
dependencies — your work is isolated.

PRE-COMMIT REVIEW GATE

Before committing your deliverables, you MUST self-review:

1. Spawn a reviewer subagent via the Agent tool. Provide it: the spec above,
   the list of deliverable files you produced, and the contents of each
   deliverable. Ask the reviewer to evaluate whether the deliverable fully
   addresses the spec, has internal logic, names sources where applicable,
   and is concrete enough to act on. The reviewer must output a JSON object
   on its final line:
   `{"verdict":"PASS"|"REVISE","notes":"..."}`

2. If verdict is PASS → proceed to commit and to the OUTPUT PROTOCOL below.

3. If verdict is REVISE → discard or rewrite the deliverable based on the
   notes. Then re-run the reviewer. Maximum 3 review rounds. If the third
   review still says REVISE, commit what you have anyway and note the
   unresolved feedback in your final SUMMARY.

OUTPUT PROTOCOL

After committing, output exactly three lines at the very end of your final
message (these will be parsed by the kanban worker — be precise):

DELIVERABLES: /deliverables/<file1>, /deliverables/<file2>, ...
SUMMARY: <≤300 words describing what you produced, key decisions, and
         (if applicable) unresolved reviewer notes>
FINAL COMMIT: <sha>

If review never converged (3 REVISE rounds), prepend "[REVIEW UNCONVERGED] "
to the SUMMARY content.
```

### Worker changes (`src/lib/card-execution/worker.ts`)

Modify `handleTerminal` (or extract a `handleDone` helper) for the `done` + `exitCode=0` path:

1. Parse the output text for three trailing protocol lines (regex-anchored to end-of-output): `DELIVERABLES: ...`, `SUMMARY: ...`, `FINAL COMMIT: ...`.
2. Resolve the project repo path by reading `/root/ClaudeMCP/projects.json` (cache for 60s, similar to `projects.ts`). Look up `path` field for the project name.
3. For each deliverable path:
   a. Resolve full path: `<projectPath>/<deliverablePath>` (deliverablePath is repo-relative).
   b. Read the file. If missing, skip and accumulate a warning.
   c. Copy into `/opt/kanban/uploads/` using the existing storage driver. Use `path.basename(deliverable)` as the filename suffix.
   d. Insert a row in `artifacts` table: `{ cardId, filename, storageKey, mimeType (sniff or derive from extension), size, uploadedById: 'agent-claude-code' }`.
4. Post the `SUMMARY:` content as a comment by `agent-claude-code`. Prepend a header line: `**Claude Code delivered:**` then the summary, then a footer listing the attached artifact filenames.
5. If parsing failed (no `DELIVERABLES:` line) → fall back to M2 behavior (post full output) AND post a second warning comment: `[M3 protocol warning] Claude did not output a DELIVERABLES: line. No artifacts were attached. Reviewing manually.`
6. Move card to Review column (unchanged from M2).

### New helper: `src/lib/card-execution/deliverables.ts`

```ts
export interface ParsedDeliverableOutput {
  deliverables: string[]
  summary: string | null
  finalCommit: string | null
  reviewUnconverged: boolean
}

export function parseDeliverableOutput(output: string): ParsedDeliverableOutput

export async function resolveProjectPath(projectName: string): Promise<string | null>
// Reads /root/ClaudeMCP/projects.json, returns the path field for the named project, or null.

export async function attachDeliverableArtifact(
  cardId: string,
  projectPath: string,
  deliverableRepoPath: string
): Promise<{ artifactId: string; filename: string } | { skipped: string }>
// Reads file from projectPath + deliverableRepoPath, copies to kanban uploads, inserts artifacts row.
// Returns { skipped } if the file is missing/empty.
```

### `claude_build` call shape

The `runTests` parameter on the kanban side defaults to `false` for M3 (was true by default at the ClaudeMCP layer). Pass `runTests: false` explicitly.

Branch naming, project resolution, debounce: unchanged from M2.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| E1 | Claude omits `DELIVERABLES:` line | Fall back to M2 (post full output). Post second warning comment. Move to Review. No artifacts. |
| E2 | `DELIVERABLES:` line lists a file that doesn't exist on the branch | Skip that file. Continue with others. Warning comment lists missed files. |
| E3 | `DELIVERABLES:` lists files outside `/deliverables/` (security) | Reject any path that doesn't start with `/deliverables/` or that contains `..`. Skip with warning. |
| E4 | Multiple deliverables, one fails to copy | Attach the ones that work. Warning comment lists failures. Card still moves to Review. |
| E5 | Reviewer never converges (3 REVISE rounds) | Claude commits anyway and prepends `[REVIEW UNCONVERGED]` to summary. Card still moves to Review. |
| E6 | Project path not found in `projects.json` | Treat as M2 failure: move to Blocked, comment with error. (Should not happen if the project trigger fired; projects.json is the source of truth.) |
| E7 | Deliverable file >10 MB | Reject; standard kanban artifact size cap (TBD what it currently is — verify in `artifacts/route.ts`). Post warning. |
| E8 | Claude installs libraries into `.venv-agent/` then accidentally commits it | The instructions say "do not commit the venv" but a robust commit hook isn't enforced. Mitigation: the spec text is explicit, and if it ends up committed, it's a one-time noise commit on the agent branch (the project's main branch is unaffected). Acceptable. |
| E9 | Per-card flag wants `runTests: true` (a real code task) | Out of scope for M3. Defer until needed. |
| E10 | Card has no description (re-check from M2) | M2 invariant check still fires — no execution starts. |
| E11 | `runTests: false` passed but ClaudeMCP's internal prompt still includes "run tests" instructions | Verify ClaudeMCP's behavior; if it still nudges Claude toward running tests, document that the M3 spec text overrides via explicit "do not run tests unless implementing code". |

## Acceptance criteria

1. **Deliverable attached** — A card on a board mapped to a real ClaudeMCP project, with a non-code spec ("Write me a 1-page summary of X"), moves through In Progress → after 60s the worker fires `claude_build` with the enriched spec. On `done`, the worker reads `/deliverables/summary.md` from the agent branch, attaches it as an artifact on the card. The card's artifact pane shows the file.
2. **Summary comment** — The card has exactly one comment from Claude Code post-completion, containing the parsed `SUMMARY:` content (≤300 words), NOT the full subprocess output.
3. **Multiple deliverables** — Given a card whose spec yields two deliverables (e.g., "Generate a sales model and a one-slide pitch"), both files end up as separate artifacts on the card, in the order listed in `DELIVERABLES:`.
4. **Format diversity** — Given a card requesting "a financial projection in spreadsheet form", the deliverable is a `.xlsx` file, readable as a valid Excel file (not a markdown table). Same test with "build me a 5-slide deck" → `.pptx`.
5. **Reviewer round 1 PASS** — When the reviewer subagent verdict is PASS on the first round, commit proceeds normally and the summary contains no `[REVIEW UNCONVERGED]` prefix.
6. **Reviewer iterates and converges** — A spec deliberately constructed to invite a first-pass miss (e.g., asking for "5 specific channel recommendations with cost estimates" but Claude's first draft omits costs) results in the reviewer issuing REVISE, Claude amending, and a PASS on round 2 or 3. The committed deliverable contains the amended content.
7. **Reviewer never converges** — On a spec impossible to satisfy in 3 rounds, the final deliverable is committed anyway, and the SUMMARY comment is prefixed with `[REVIEW UNCONVERGED]`.
8. **Missing `DELIVERABLES:` line (graceful fallback)** — A `claude_build` job that completes successfully but whose output has no `DELIVERABLES:` line still results in: card → Review, comment with full output (M2 behavior), and a second warning comment flagging the protocol miss.
9. **Path escape rejected** — A `DELIVERABLES:` line containing `../etc/passwd` or `/etc/passwd` is rejected; that file is not copied. A warning comment lists the rejected paths.
10. **Library bootstrapping** — A task requiring docx output runs successfully on a project where python-docx is not pre-installed; Claude provisions `.venv-agent/` and produces a valid `.docx`.
11. **Backwards compat** — Existing M2 CardExecution rows (state=done, completed before M3 ships) continue to render correctly in the UI. No DB schema change required for M3.

## Architecture decision

- One new file: `src/lib/card-execution/deliverables.ts`
- Two surgical edits: `worker.ts` (`handleTerminal` branch on success), and a small change to `fireExecutionForCard` to enrich the spec.
- No Prisma schema migration (M1 artifacts table is already adequate).
- No ClaudeMCP repo changes.
- All M3 changes are kanban-side. ClaudeMCP just sees a longer `spec` string.

## Open / deferred

- **Reviewer loop telemetry** — for now, the reviewer rounds live inside the `claude -p` subprocess and don't surface to the kanban card. M4 could persist each round's transcript and let the user expand them. Defer.
- **Per-card deliverable type override** — e.g., a checkbox "code task" toggle that flips `runTests` to true and disables the deliverable requirement. Defer until needed.
- **PDF deliverables** — Adding LaTeX/wkhtmltopdf is heavier than the Python libs. Defer until a card needs it.
- **Artifact preview in card UI** — Today's artifact rendering may not preview xlsx/pptx inline. Out of scope for M3 (it's enough that they download). UX iteration in M4.
- **Reviewer impartiality** — Today the reviewer is the same Claude model. We could use a different model for genuine adversarial review. Defer.
