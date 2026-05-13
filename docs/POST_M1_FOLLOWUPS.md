# Post-M1 Follow-Ups

Status board for items deferred during M1. Updated as work lands.

## Security & Dependencies

### 1. Next.js HIGH-severity CVEs ✅ DONE

Upgraded `next` from `14.2.35` to `16.2.6` (pinned exact). All four target HIGH advisories cleared (HTTP smuggling, RSC DoS, Image Optimizer DoS, fast-uri path traversal). Migration covered route handler params-as-Promise, async `cookies()`/`headers()`, middleware → proxy rename, ESLint 8 → 9 flat config.

### 2. `fast-uri` HIGH (transitive) ✅ DONE

Resolved with #1 (fast-uri is now patched in the Next.js 16 dependency tree).

### 3. Security headers missing ✅ DONE

`next.config.js` `async headers()` returns:

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (production only)

### 4. Depth-cap race condition ✅ DONE

Card create now wraps the parent-depth re-read + insert in a single `prisma.$transaction`. Two concurrent creates under the same parent serialise correctly.

### 5. AI worker cost-amplification controls ✅ DONE (partial — cooldown)

Per-artifact cooldown: `enqueueAiReview` returns `false` if a `pending`/`running` review exists; manual trigger route returns 409. Per-org budget and per-org daily request count are still open — see [Future work](#future-work-not-yet-actioned).

### 6. `bootstrapWorker` doesn't reset `startedAt` ✅ DONE

Orphan recovery on app boot now sets `startedAt: null` alongside `status: 'pending'`. Re-processed jobs report accurate durations.

### 7. `rubricSnapshot` exposed in GET responses ✅ RESOLVED

Product decision: org members can see rubrics. Current behavior (org-wide visibility) is intended. No code change.

## Operational

### 8. AI Reviewer User ID capture ✅ DONE

`.env.example` documents the capture procedure. Run `npm run db:seed-ai-reviewer` once; copy the printed cuid to `.env` as `AI_REVIEWER_USER_ID`. Optional — worker resolves by email if unset.

### 9. `npm install` requires `--include=dev` ✅ DONE

Repo `.npmrc` sets `include=dev`, overriding the server-wide `NODE_ENV=production` → `omit=dev` default. `npm install` now installs devDependencies without any extra flags.

### 10. `npm run lint` not configured ✅ DONE

`eslint.config.js` flat-config (ESLint 9) extends `next/core-web-vitals`. `npm run lint` runs cleanly (0 errors, 9 cosmetic warnings about stale `eslint-disable` directives — see [Future work](#future-work-not-yet-actioned)).

### 11. Prettier configured but not enforced ✅ DONE

`.prettierrc.json` + `.prettierignore` in place. Codebase reformatted once. Run `npx prettier --write .` to keep new code clean.

### 12. `.gitignore` for `.next/` ✅ DONE

`.next/` is in `.gitignore` and `git rm --cached -r .next/` was run to untrack the previously-committed build artifacts.

## Test infrastructure

### 13. AC-1 / AC-3 manual smoke step ✅ DONE

`scripts/smoke.sh` + `npm run smoke` wrap the destructive smoke test (`rm kanban.db && db:push && db:seed && npm test`). 484 tests pass after a fresh DB cycle.

### 14. E5 manual QA → automated Playwright ✅ DONE

`e2e/assignee-former-member.spec.ts` (Playwright + chromium, pinned 1.60.0). Test surfaced + fixed a real `RoleSelector.tsx` bug: previously rendered a blank select when the assigned user was no longer in `orgMembers`. Now injects a disabled `(former member)` option.

## Product / spec open questions

### 15. Description-only AI review ✅ DONE

`POST /api/cards/[id]/reviews` triggers AI review on the card's `description` (no artifact required). Schema migration made `AiReview.artifactId` nullable and added a required `cardId`. Worker branches on `artifactId` presence. 17 new tests.

### 16. Board-level default rubric ❌ WON'T DO

Product decision: not adding. Inheritance chain remains `card → ancestors → env default`.

### 17. "Assigned to me" notification feed ✅ DONE

All three surfaces shipped:

- **API:** `GET /api/me/assignments` returns 4 categories (`asAssignee`, `asReviewer`, `asApprover`, `overdue`).
- **Dashboard widget:** Three collapsible sections with SWR + 30s refresh on the `/dashboard` page.
- **Avatar badge:** Numeric red badge on the Sidebar avatar; hidden at 0; capped at 99+; shares SWR cache with the widget.
- **Email digest:** `POST /api/cron/digest` with `CRON_SECRET` bearer auth; pluggable email provider (`EMAIL_PROVIDER=log` default; `resend` stub for M2).

### 18. Cross-org 404 vs 403 hardening ✅ DONE

All 14 `resolveX` helpers across cards / boards / artifacts / sprints / tickets routes now return 404 on cross-org access. 5 test assertions flipped from 403 to 404.

## Additional fixes that landed (not in original list)

### 19. `prisma/seed.ts` idempotent ✅ DONE

Replaced `.create()` with `.upsert()` for the demo Organization, admin User, and OrgMember. Skips board/sprint/cards creation if a demo board already exists. `scripts/smoke.sh` is now re-runnable.

### 20. `react-hooks/set-state-in-effect` errors ✅ DONE

Two ESLint errors fixed in `AiReviewToggle.tsx` (via `key={card.id}` on the parent — component remounts on card change) and `CardModal.tsx` (via the documented "previous prop in state" pattern — sync state during render, not in an effect).

---

## Future work (not yet actioned)

Smaller items that have come up but aren't blocking. Pick up at your discretion:

- **Per-org daily token budget + request count** for AI reviews (item #5 partial — per-artifact cooldown landed; org-level budget is still open). Important before prod scale.
- **PostCSS moderate** inside `next@16.2.6`'s bundle — `npm audit` flags 2 moderate. Not fixable without a Next.js patch upstream; track until they release one.
- **`typescript: { ignoreBuildErrors: true }` in `next.config.js`** — pre-existing debt. tsc is clean right now so it's dormant, but it should come off once we trust the type gate.
- **9 stale `eslint-disable` directives** scattered through `__tests__/components/_helpers/mock-swr.ts`, `__tests__/lib/extractors.test.ts`, and `src/app/api/artifacts/[artifactId]/download/route.ts`. Run `npx eslint . --fix` — should be auto-cleanable.
- **Real Resend integration** for the email digest. The pluggable provider is in place; flip `EMAIL_PROVIDER=resend` and finish `src/lib/email/providers/resend.ts`.
- **Real cron scheduler** for `POST /api/cron/digest` — endpoint exists with bearer auth, but needs a scheduler (Vercel cron, GitHub Actions schedule, or external).
- **Multi-instance proxy rate limiter** — `src/proxy.ts` uses an in-memory sliding window. Replace with Redis or KV-backed counter when running >1 process / serverless.
- **Web Push** for the assigned-to-me badge — currently SWR polls every 30s. Push would be more efficient.

## M2 scope

External-doc AI review (referenced from M1 spec §11):

- OAuth (per-user Google identity)
- Drive / Docs / Sheets / Slides API clients
- Content adapter abstraction (`UploadedFile | GoogleDoc | GoogleSheet | GoogleSlide`)
- Token refresh, rate limiting
- Permission handling on revoked-access mid-review
