# Task 07 — Token-bucket rate limiter per `userId` (in-memory)

**Agent type:** coder
**Depends on:** 01-oauth, 02-drive, 03-exporters
**Spec sections:** M4 spec — "Rate limiting" block, AC-18, E21

---

## Goal

Add a process-local per-user token-bucket rate limiter and wrap every outbound Google HTTP call with it. Bucket capacity 60, refill 60/min. When empty, the caller awaits up to 30 seconds; beyond that, surface a typed `RateLimitExceededError`. Also implement the 3-attempt exponential backoff on 429/5xx (1s, 4s, 16s) at the same wrap point so retries are consistent across modules.

## Inputs — files to read first

- `/opt/kanban/src/lib/google/fetch.ts` — the wrapper that everything currently routes through. This task wraps `googleFetch` with bucket + retry.
- `/opt/kanban/src/lib/google/oauth.ts`, `drive.ts`, `docs.ts`, `sheets.ts`, `slides.ts` — confirm they all use `googleFetch` (no direct `fetch` calls). Audit and flag if any do.
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — Rate-limiting + E21 + AC-18

## Files to create / modify

**Create:**

- `/opt/kanban/src/lib/google/rate-limit.ts` — bucket implementation + `consume(userId)`
- `/opt/kanban/__tests__/lib/google/rate-limit.test.ts`

**Modify:**

- `/opt/kanban/src/lib/google/fetch.ts` — accept an optional `{ userId, retry?: boolean }` second-arg option; when `userId` is set, call `consume(userId)` before the fetch and apply retry on 429/5xx
- `/opt/kanban/src/lib/google/errors.ts` — add `RateLimitExceededError` (`code: 'RATE_LIMIT_EXCEEDED'`)
- `/opt/kanban/src/lib/google/oauth.ts`, `drive.ts`, `docs.ts`, `sheets.ts`, `slides.ts` — pass `{ userId, retry: true }` to every `googleFetch` call where we have a `userId`. For the OAuth token-exchange in `exchangeCode` (no userId yet), pass `{ retry: true }` only (token endpoint isn't on the user's quota; still benefits from retry).

## Interface contract

### `src/lib/google/rate-limit.ts`

```ts
export interface RateLimitOptions {
  capacity: number   // default 60
  refillPerMinute: number  // default 60
  maxWaitMs: number  // default 30_000
}

const DEFAULT_OPTS: RateLimitOptions = { capacity: 60, refillPerMinute: 60, maxWaitMs: 30_000 }

/**
 * Awaits 1 token from the bucket for `userId`. If the wait would exceed
 * maxWaitMs, throws RateLimitExceededError. Otherwise returns when a token
 * is granted. Time-based; uses Date.now() (or an injected clock for tests).
 */
export async function consume(userId: string): Promise<void>

/** Test seam — replace the in-memory state. */
export function __resetBucketsForTests(): void

/** Test seam — inject a clock (returning ms). */
export function __setClockForTests(now: () => number): void

/** Test seam — inject a sleeper (returning Promise<void>). */
export function __setSleeperForTests(sleeper: (ms: number) => Promise<void>): void
```

Algorithm:

- One `Bucket = { tokens: number; lastRefillMs: number; queueDepth: number }` per userId in a `Map<string, Bucket>`
- On consume:
  - Refill: `tokens = min(capacity, tokens + elapsed * (refillPerMinute / 60_000))`. Update `lastRefillMs`.
  - If `tokens >= 1` → decrement, return
  - Else compute `waitMs = ceil((1 - tokens) * (60_000 / refillPerMinute))`. If `waitMs > maxWaitMs` → throw `RateLimitExceededError`. Else `await sleep(waitMs)` and retry from the top.
- No queueing fairness needed — a single-process Next dev/prod server is single-threaded in JS terms; concurrent awaits are serialised by the event loop. Tests verify ordering only at a coarse granularity.

### Retry inside `googleFetch`

When `retry: true`:

- Attempt up to 3 times
- Treat retryable: HTTP status `429` or `>= 500`
- Treat permanent: HTTP status `400`, `401`, `403`, `404`, `409` — return immediately, do NOT retry
- Backoff between attempts: 1000ms, 4000ms, 16000ms (so 3 attempts = up to 21s total wait)
- Use the same injectable sleeper from rate-limit.ts (so tests can fake timers across both)
- After the third failed attempt, return the final response unchanged (callers throw their own typed errors based on status)

### Module audit (do as part of this task)

Run `grep -rn "fetch(" /opt/kanban/src/lib/google/ | grep -v googleFetch | grep -v __tests__`. Expect zero hits. If any file uses raw `fetch`, route it through `googleFetch` before merging.

## Hard rules

1. **In-memory only.** Multi-instance Redis is explicitly deferred (spec wording). Do not add a Redis dependency.
2. **No global singleton mutation in tests.** All three `__set*ForTests` helpers must `__resetBucketsForTests` in test `afterEach` or `beforeEach` to keep tests hermetic.
3. **Sleeper injection** must default to `setTimeout`-based sleep. Tests use a fake sleeper that records calls and resolves synchronously.
4. **Retry-aware errors:** retry only on transient (429, 5xx). Do NOT retry on `invalid_grant` (it's 400) — that path raises `TokenRevokedError` and must surface immediately.
5. **Folder enumeration is the primary risk for E21.** Tests must cover a 60+ rapid sequence of `consume(userId)` calls and verify throttling.
6. Functions ≤ 40 lines.
7. **No `any`.** Bucket type explicit. Sleeper type `(ms: number) => Promise<void>`.

## Tests to write

`/opt/kanban/__tests__/lib/google/rate-limit.test.ts` — use `__setClockForTests` and `__setSleeperForTests` with a recording fake sleeper that simulates time advance.

- **Bucket starts at capacity (60):** 60 consecutive `consume('u1')` calls resolve without sleep
- **61st call sleeps:** the fake sleeper is called once with `~1000ms` (one token's worth at 60/min); after the sleep, consume resolves
- **Per-user isolation:** consume('u1') 60 times, then consume('u2') resolves immediately (separate bucket)
- **maxWaitMs exceeded:** with `capacity=1, refillPerMinute=1, maxWaitMs=100`, consume 1 token, consume again → throws `RateLimitExceededError` (next token would take 60s)
- **Refill over time:** consume 60, advance clock 30s, the next consume should wait ~0ms (30 tokens refilled)
- **AC-18 scenario:** seed 60 rapid consume calls, then 5 more — assert the fake sleeper was called at least once, and that no consume call resulted in a real network attempt (since this test isolates the bucket from googleFetch)

`/opt/kanban/__tests__/lib/google/fetch-retry.test.ts` — verify retry behaviour inside `googleFetch`:

- 429 then 200 (with `retry: true`) → resolves on second attempt; sleeper called once with `1000ms`
- 500, 500, 200 → resolves on third attempt; sleeper called with `1000ms` then `4000ms`
- 429, 429, 429 → resolves to the third 429 response (caller handles); sleeper called with `1000ms`, `4000ms` (not `16000ms` — the third attempt happens, then no further retry)

  Wait — re-read: spec says retry up to 3 attempts with 1s/4s/16s. 3 attempts → 2 backoffs. The `16000ms` is between attempts 3 and 4 — but there is no attempt 4. So the correct expected sleeper calls are `1000ms` (between 1 and 2) and `4000ms` (between 2 and 3). Confirm this matches Task 05 of M1 wording. **Coder: implement 2 backoffs (1s, 4s) for 3 attempts. If reviewing M1, you'll see the same pattern.**

  Actually M1 Task 05 says: "Retries up to 3 times with exponential backoff (1s, 4s, 16s)". That implies 3 backoffs → 4 attempts. **Resolve:** match the M1 worker's existing behaviour exactly. Read `/opt/kanban/src/lib/ai-review/claude-client.ts` `RETRY_DELAYS` to confirm — it shows `[1000, 4000, 16000]` and `MAX_ATTEMPTS = 3` (so 3 attempts, 2 backoffs are actually used since the loop sleeps before each *retry*, not before the first attempt). **Use that exact constant array `[1000, 4000, 16000]` and slice as needed for `MAX_ATTEMPTS=3`.** Match claude-client's loop structure.

- 401 → resolves immediately to the 401 response; sleeper NOT called
- 404 → resolves immediately; sleeper NOT called
- 403 → resolves immediately; sleeper NOT called

- Network error (fetch throws) with retry: caught and treated as retryable; on third throw, propagates
- `retry: false` (default for OAuth callback's exchangeCode — no, exchangeCode opts in) → no retry on 5xx

## Verification gate (all must pass)

- `cd /opt/kanban && grep -rn "fetch(" src/lib/google/ | grep -v googleFetch | grep -v __tests__` returns nothing
- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32) npx vitest run __tests__/lib/google/`
- Full suite: `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — full or partial

- **AC-18** (Rate-limit handling: 60+ rapid attaches throttled, no 5xx) — full responsibility
- **E21** (Google 5xx retry/backoff with 3 attempts) — full responsibility for the retry mechanism; final-failure AiReview row creation is the worker's existing behaviour

## Out of scope

- Distributed/Redis-backed rate limiting
- Surfacing rate-limit status in the UI

## Done when

- Bucket implemented; every Google module's fetch wraps `userId` (where known) + `retry: true`.
- All rate-limit tests pass.
- Existing oauth / drive / exporters tests still pass (their stubs continue to work because the bucket is bypassed when the test stub of `googleFetch` is installed — confirm).
- Single commit on `feat/m4-07-rate-limit`.

## Escalate if

- Wrapping `googleFetch` accidentally breaks an existing test that stubbed pre-wrap behaviour — re-architect so the stub seat is on the *unwrapped* `googleFetch` (i.e., the wrapper composes with the stub).
- Two-stage retry interacts badly with the bucket's await (e.g., rate-limited retry stretches total wait past 60s) — document the worst-case wall-clock and confirm Brad accepts.
