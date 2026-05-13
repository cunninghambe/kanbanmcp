# Task 10 — Integration test pass: AC coverage, regression sweep

**Agent type:** qa (executed by coder)
**Depends on:** all prior tasks (01–09)
**Spec sections:** §7 (Acceptance Criteria), §9 (Test Plan Summary)

---

## Goal

Verify that every numbered acceptance criterion (AC-1 through AC-14) maps to at least one passing test, that all the edge cases (E1–E16) have explicit coverage where the spec demands it, and that the existing test suite has been updated for the new `assigneeId`-required-on-create contract. Add any missing tests, fix any failing existing tests caused by the contract changes, and produce a coverage matrix in this task's PR description.

This task is not a "spec drift" review — that is the architect's separate review pass. This task is "are the tests we said we'd write actually there and green?"

## Inputs — files to read first

- M1 spec §7 (acceptance criteria) and §9 (test plan summary)
- Each prior task's "Tests to write" section
- `/root/kanbanmcp/__tests__/cards-api.test.ts` — existing tests that may need fixture updates
- All `__tests__/api/*`, `__tests__/lib/*`, `__tests__/mcp/*`, `__tests__/components/*` files produced by Tasks 02–09

## Files to create / modify

**Modify:**

- Any existing test file whose fixtures break due to `assigneeId` being required on create (Task 02). Add a default `assigneeId` to every create-card fixture in `cards-api.test.ts` etc.
- The PR description for Task 10's commit — include the coverage matrix below

**Create only if missing after prior tasks:**

- `/root/kanbanmcp/__tests__/integration/m1-end-to-end.test.ts` — one happy-path test that walks: create parent → create child (subcard) → upload artifact with `aiAutoReview=true` (mocked Claude) → wait for review done → reviewer submits APPROVED signoff → verify comment exists, signoff visible, tree query returns the parent with the child

## Coverage matrix (deliverable in PR description)

The PR description must include a markdown table mapping each AC and key edge case to the test file and test name. Template:

| ID    | File                                                        | Test name                                                        | Status  |
| ----- | ----------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| AC-1  | manual / CI lint                                            | `prisma migrate dev succeeds`                                    | manual  |
| AC-2  | `__tests__/api/cards-api.test.ts`                           | `PATCH rejects assigneeId: null`                                 | passing |
| AC-3  | `__tests__/prisma/seed-ai-reviewer.test.ts`                 | `is idempotent`                                                  | passing |
| AC-4  | `__tests__/api/cards-create.test.ts`                        | `400 when assigneeId missing`                                    | passing |
| AC-5  | `__tests__/api/artifacts-upload.test.ts`                    | `stores file and returns 201`                                    | passing |
| AC-6  | `__tests__/api/ai-review-pipeline.test.ts`                  | `upload → enqueue → done → comment`                              | passing |
| AC-7  | `__tests__/api/signoffs.test.ts`                            | `non-reviewer non-approver → 403`                                | passing |
| AC-8  | `__tests__/api/cards-children.test.ts`                      | `returns subtree with signoffs latest per role`                  | passing |
| AC-9  | `__tests__/api/cards-reparent.test.ts`                      | `400 on cycle`                                                   | passing |
| AC-10 | `__tests__/api/cards-reparent.test.ts`                      | `400 on depth > 50`                                              | passing |
| AC-11 | `__tests__/lib/inheritance.test.ts`                         | `inherits parent params when null`                               | passing |
| AC-12 | `__tests__/lib/inheritance.test.ts`                         | `walker terminates at 50`                                        | passing |
| AC-13 | `__tests__/mcp/tools.test.ts`                               | `create_subcard sets parentCardId path depth`                    | passing |
| AC-14 | `__tests__/mcp/tools.test.ts`                               | `list_card_tree shape matches /children`                         | passing |
| E1    | `__tests__/api/cards-delete-with-children.test.ts`          | `children become roots with recomputed paths`                    | passing |
| E2    | covered by AC-9 cycle + AC-10 depth tests                   | —                                                                | passing |
| E3    | covered by AC-9                                             | —                                                                | passing |
| E4    | covered by AC-10                                            | —                                                                | passing |
| E5    | not covered in M1 — manual QA only (former-member assignee) | —                                                                | manual  |
| E6    | `__tests__/api/signoffs.test.ts`                            | `reviewer attempting APPROVER → 403`                             | passing |
| E7    | `__tests__/api/ai-review-pipeline.test.ts`                  | `aiAutoReview toggled after upload does not auto-review history` | passing |
| E8    | `__tests__/api/ai-review-pipeline.test.ts`                  | `no params anywhere → failed`                                    | passing |
| E9    | `__tests__/lib/claude-client.test.ts`                       | `429 retry backoff and exhaustion`                               | passing |
| E10   | `__tests__/api/artifacts-upload.test.ts`                    | `415 on disallowed MIME`                                         | passing |
| E11   | `__tests__/api/artifacts-upload.test.ts`                    | `413 on oversize`                                                | passing |
| E12   | `__tests__/lib/extractors.test.ts`                          | `empty PDF text → empty` + pipeline `skipped`                    | passing |
| E13   | `__tests__/api/ai-review-pipeline.test.ts`                  | `concurrent uploads queue in order`                              | passing |
| E14   | `__tests__/api/ai-review-pipeline.test.ts`                  | `artifact deleted mid-review → done, no comment`                 | passing |
| E15   | `__tests__/api/signoffs.test.ts`                            | `400 No reviewer assigned`                                       | passing |
| E16   | `__tests__/lib/inheritance.test.ts`                         | `null chain falls through to grandparent`                        | passing |

If any cell says "missing" — add the test before merging.

## Implementation notes

1. **No new mocks.** Reuse the patterns already established in prior tasks. Vitest `vi.mock` for `@/lib/db`, `@/lib/storage`, `@anthropic-ai/sdk`, `iron-session`, `next/headers`.
2. **The integration test is small.** ~150 lines, single happy path. It is NOT a load test. It uses the same mocks as unit tests — what makes it "integration" is that it composes multiple endpoints.
3. **AC-1 / AC-3 are partly manual.** Migrations and the seed script's effects against a real SQLite file are exercised by running `rm kanban.db && npm run db:push && npm run db:seed && npm test`. Document this command in the PR description as the "manual smoke" step.
4. **Fixture updates.** Existing `cards-api.test.ts` POST tests will fail because `createCardSchema` now requires `assigneeId`. Add `assigneeId: 'user-1'` (or similar) to every create payload. Document in the commit message which fixtures changed.
5. **Watch for test pollution.** Each test should `vi.clearAllMocks()` in `beforeEach`. The existing pattern uses this — preserve it.

## Acceptance criteria

- The coverage matrix is complete with no "missing" cells.
- `npm test` passes locally with the documented env (`SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db`).
- `npx tsc --noEmit` passes.
- The manual smoke command (`rm kanban.db && npm run db:push && npm run db:seed && npm test`) is documented and verified by the QA agent on a fresh DB.

## Tests to write

(All test files referenced in the coverage matrix above. Most are produced by prior tasks; this task is primarily a verification pass.)

The only test file unique to this task:

- `/root/kanbanmcp/__tests__/integration/m1-end-to-end.test.ts`

## Out of scope for this task

- Load / performance testing
- Real Claude API calls
- Real S3 driver testing
- UI smoke under a real browser
- Linting fixes unrelated to M1

## Done when

- Coverage matrix is complete and accurate; PR description contains it verbatim.
- All tests pass; existing tests updated for new fixtures.
- Single commit on `feat/m1-review-workflow`.
