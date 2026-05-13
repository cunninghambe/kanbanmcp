# Post-M1 Follow-Ups

Items deliberately deferred during M1 implementation. Tracked here so M2/M3 sprints can pick them up.

## Security & Dependencies

### 1. Next.js HIGH-severity CVEs (pre-existing on `main`)

Current: `next@^14.2.21` carries several HIGH-severity audit findings:

- **GHSA-h25m-26qc-wcjf** — HTTP request deserialization DoS with RSC
- **GHSA-ggv3-7p47-pfv8** — HTTP request smuggling in rewrites
- **GHSA-9g9p-9gw9-jx7f** — DoS via Image Optimizer remotePatterns
- (~12 more advisories)

`npm audit fix --force` upgrades to Next.js 16 (breaking). Needs a planned upgrade sprint covering route handler changes, instrumentation API stability, and SSR behaviour. Out of scope for M1.

Until upgraded: pin to exact version (`"next": "14.2.21"` instead of `^14.2.21`) to prevent silent CVE-introducing upgrades.

### 2. `fast-uri` HIGH (transitive)

- **GHSA-q3j6-qgpj-74h6** — path traversal via percent-encoded dot segments
- **GHSA-v39h-62p7-jpjc** — host confusion via percent-encoded authority delimiters

Transitive through Next.js. Resolves when #1 is fixed.

### 3. Security headers missing

`next.config.js` does not set `X-Frame-Options`, `X-Content-Type-Options`, or `Strict-Transport-Security`. Add a `headers()` config to apply these globally on API routes and pages before production deployment.

### 4. Depth-cap race condition

The card-create depth check (`parent.depth + 1 >= MAX_NESTING_DEPTH`) is not wrapped in a transaction with the insert. Two concurrent inserts under the same depth-49 parent could theoretically both pass the check and produce two depth-50 children. The cap is 50 levels, exceeding it by 1 has minimal practical impact, but a `$transaction` wrapper is the correct long-term fix.

### 5. AI worker cost-amplification controls

Any org member can call `POST /api/artifacts/[id]/reviews` repeatedly, queuing unbounded Claude calls. M1 has single-concurrency queue (serialises) but no per-org or per-artifact rate limit. Before production:

- Per-artifact cooldown (one `pending` review at a time)
- Per-org daily token budget
- Per-org daily request count

### 6. AI Reviewer `bootstrapWorker` doesn't reset `startedAt`

When `running` rows are reset to `pending` on app boot, `startedAt` is not cleared. Re-processed jobs report a misleading `finishedAt - startedAt` duration. Minor data-integrity issue; fix is one line in `src/lib/ai-review/worker.ts`.

### 7. `rubricSnapshot` exposed in GET responses

`GET /api/reviews/[reviewId]` and `GET /api/artifacts/[id]/reviews` include `rubricSnapshot` in the response. Any org MEMBER can read another team's rubric criteria. Whether this is intended is a product question. If not, redact for non-author readers.

## Operational

### 8. AI Reviewer User ID capture

After running `npm run db:seed-ai-reviewer` on a fresh DB, the script logs `[seed-ai-reviewer] id=<cuid>`. Copy that cuid into `.env` as `AI_REVIEWER_USER_ID=<cuid>` to skip the in-memory email-lookup cache on every worker boot. Optional; the worker resolves by email if the env var is unset.

### 9. `npm install` requires `--include=dev`

Global npm config has `omit=dev` on this server. Running `npm install` will silently drop devDependencies (including `vitest`, `@types/node`, `@vitejs/plugin-react`). Use `npm install --include=dev` until the global config is fixed.

### 10. `npm run lint` not configured

The repo has no `.eslintrc` / `eslint.config.js`. `next lint` drops into an interactive setup wizard. ESLint config should be added — or `lint` should be removed from `package.json`'s scripts.

### 11. Prettier configured but not enforced

~90 files in the repo fail `prettier --check`. Not introduced by M1 work; pre-existing. Either run prettier across the codebase or remove the gate.

### 12. `.gitignore` for `.next/`

The `.next/` directory is not in `.gitignore`. Generated build artifacts can leak into staging. Add `.next/` to `.gitignore` and run `git rm --cached -r .next/` once.

## Test infrastructure

### 13. AC-1 / AC-3 manual smoke step

Per the M1.10 PR, AC-1 (fresh-DB migration) and AC-3 (seed idempotency) are manual smoke steps because they require destroying `kanban.db`:

```bash
rm /root/kanbanmcp/kanban.db
npm run db:push
npm run db:seed
npm test
```

Worth wrapping in a `scripts/smoke.sh` and CI matrix.

### 14. E5 manual QA

Edge case E5 ("assignee removed from org → '(former member)' shown in UI") is a manual-QA-only check. Worth a Playwright/Cypress integration test in M2/M3.

## Product / spec open questions

### 15. Description-only AI review

Spec §11 open question: should AI review be runnable on the card description alone (no artifact), e.g. "review this spec text"? M1 says no — only artifacts. Decide for M2.

### 16. Board-level default rubric

Currently the AI review default rubric falls back to env (`AI_REVIEW_DEFAULT_RUBRIC`). Board-level defaults are a small extra schema field if wanted.

### 17. "Assigned to me" notification feed

Spec §11 open question. Punted to M3.

### 18. Cross-org 404 vs 403 hardening — partial

Only the new M1 routes (signoffs, children/promote/reparent, AI review routes) return 404 for cross-org. Existing routes (`cards/[cardId]/route.ts`, `boards/[boardId]/cards/route.ts` for non-M1 fields, sprints, etc.) still return 403. Globalise during the next security pass.

## M2 scope (referenced from M1 spec)

External-doc AI review:

- OAuth (per-user Google identity)
- Drive / Docs / Sheets / Slides API clients
- Content adapter abstraction (`UploadedFile | GoogleDoc | GoogleSheet | GoogleSlide`)
- Token refresh, rate limiting
- Permission handling on revoked-access mid-review
