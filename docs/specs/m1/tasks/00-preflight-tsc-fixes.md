# Task 00 — Preflight: Fix Pre-Existing TypeScript Errors on main

**Agent type:** coder
**Depends on:** Task 01 (schema, already merged in #893c9a3)
**Runs before:** all wave 2 tasks (02-card-api, 04-artifacts, 06-signoffs)
**Not part of the M1 spec** — housekeeping prerequisite. The M1 verification gate requires `npx tsc --noEmit` to pass with zero errors; today there are 6 pre-existing errors on `main` that will mask new errors introduced by wave 2 work.

---

## Goal

Fix the 6 pre-existing TypeScript errors on `main` so that subsequent M1 work has a clean `tsc --noEmit` baseline. No feature work, no refactoring beyond what each individual error requires.

## The 6 errors (as of `main` at 893c9a3)

```
__tests__/auth-api.test.ts(256,28): TS2554 — Expected 0 arguments, but got 1
prisma/seed-board.ts(52,9): TS2353 — 'orgId' does not exist on User create input
src/app/api/realtime/route.ts(78,15): TS2322 — Type 'string | null' is not assignable to 'string | StringFilter<"Card"> | undefined'
src/lib/session.ts(1,10): TS2724 — '"iron-session"' has no exported 'IronSessionOptions' (use 'SessionOptions')
src/types/index.ts(5,3): TS2724 — '"@prisma/client"' has no exported 'OrgMemberRole' (use 'OrgMember')
src/types/index.ts(11,3): TS2305 — '"@prisma/client"' has no exported member 'SprintStatus'
```

## Likely root causes (verify per file — do not assume)

1. **`auth-api.test.ts:256`** — a test calls some helper with an argument the helper no longer accepts. Read the helper signature, then fix the call site (NOT the helper) unless the test was always wrong.
2. **`seed-board.ts:52`** — seed tries to set `orgId` directly on `User.create`. The schema has `User → OrgMember → Org` (join table). Fix: create the OrgMember separately, not on the User.
3. **`realtime/route.ts:78`** — Prisma filter expects `string | undefined`, but the code is passing `string | null` (likely from `searchParams.get()`). Coerce with `?? undefined` or guard explicitly.
4. **`session.ts:1`** — iron-session v8 renamed `IronSessionOptions` to `SessionOptions`. One-line import + type fix.
5. **`types/index.ts:5`** — `OrgMemberRole` was an enum that no longer exists (schema uses `String` for `role` per SQLite). Remove the import and any usage; if a downstream file needs a union type, replace with `type OrgMemberRole = 'OWNER' | 'ADMIN' | 'MEMBER'` defined locally (check the actual valid values in `requireOrgRole`).
6. **`types/index.ts:11`** — Same as #5 for `SprintStatus`. Schema uses `String` for `Sprint.status` with default `"PLANNING"`. Valid values: check the codebase for what's actually used.

## Hard rules

1. **Branch off main:** `feat/m1-00-tsc-fixes`. PR targets `main`.
2. **One commit per error** — easier to revert any one fix in isolation if it causes runtime regressions. Or one squash commit at merge; up to you. Either way, the diff per error must be minimal.
3. **No refactoring** beyond what each error requires. Do not rename types, restructure imports, or "clean up" adjacent code.
4. **No new files** unless an error explicitly requires it.
5. **For each fix, verify behaviour did not change.** Run any test that exercises the affected code. For `realtime/route.ts:78`, manually trace whether `null` was meaningful — if the route used `null` as a "no filter" signal, the coercion must preserve that semantic.
6. **Do not touch existing tests** except `__tests__/auth-api.test.ts:256` if the test itself is wrong. If the test is correct and the helper changed, that's a regression — escalate.
7. **Verification gate before commit (all must pass):**
   - `npx tsc --noEmit` — must report 0 errors (the goal of this task)
   - `npx vitest run` — must pass, all existing + the new seed test from M1.01
   - `npm run build` — must succeed
   - `rm -f /tmp/preflight-kanban.db && DATABASE_URL=file:/tmp/preflight-kanban.db npx prisma migrate deploy` — must succeed (no regression on the M1 migration)

## Tests to add

- For each runtime change, if there isn't already a test that would have caught the bug, add one. Specifically:
  - `realtime/route.ts:78` — add a test that calls the route with `cardId=` (empty string) and confirms it doesn't 500. If the route filter is meant to be "no cardId filter", the test should cover both the present and absent cases.
  - `seed-board.ts:52` — if the fix is non-trivial, run the seed against a fresh DB and confirm at least one user is in at least one org afterwards. A shell command in CI is fine; no new unit test required if the seed is exercised by an integration test that already exists.
- Other fixes are type-only and need no new tests.

## PR

- Title: `M1.00 — fix 6 pre-existing TypeScript errors`
- Body: list each error with its fix in one line. Note in the body: "Preflight cleanup for M1 wave 2. No feature changes."
- Mark ready for review, not draft.

## Done when

- `npx tsc --noEmit` exits 0
- All tests pass
- PR is open and tagged with the M1 cleanup intent in the body

## Escalate if

- Any fix would require changing a public API (route signature, exported type)
- Any test fails that did not previously fail
- The `realtime/route.ts` null semantic is genuinely ambiguous — do not guess; flag it
