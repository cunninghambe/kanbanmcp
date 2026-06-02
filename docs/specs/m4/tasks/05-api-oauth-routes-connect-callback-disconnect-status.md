# Task 05 — API routes: `/api/me/google/{connect,callback,disconnect,status}`

**Agent type:** coder
**Depends on:** 00-schema, 01-oauth
**Spec sections:** M4 spec — "New API routes" (OAuth lifecycle block), AC-1, AC-2, AC-13, AC-16, AC-17, AC-18 (state cookie); E18

---

## Goal

Wire the OAuth lifecycle into Next 14 route handlers. Connect generates a CSRF state, sets it as an HttpOnly cookie, and 302s to Google. Callback validates the state cookie, exchanges the code, persists a `GoogleCredential` row (or replaces an existing one for the same user), and 302s to `/settings/integrations?connected=1`. Disconnect revokes Google-side and deletes the row. Status returns the connection summary.

## Inputs — files to read first

- `/opt/kanban/src/app/api/me/ai-review-queue/route.ts` — pattern for an authenticated `/api/me/*` route (cookies, `requireSession`)
- `/opt/kanban/src/lib/api-helpers.ts` — `requireSession`, `apiError`
- `/opt/kanban/src/lib/google/oauth.ts` — `buildConsentUrl`, `exchangeCode`, `revokeRefreshToken`
- `/opt/kanban/src/lib/secrets.ts` — `encryptSecret`
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — OAuth route block + E18 + AC-1, 2, 13, 16, 17

## Files to create / modify

**Create:**

- `/opt/kanban/src/app/api/me/google/connect/route.ts`
- `/opt/kanban/src/app/api/me/google/callback/route.ts`
- `/opt/kanban/src/app/api/me/google/disconnect/route.ts`
- `/opt/kanban/src/app/api/me/google/status/route.ts`
- `/opt/kanban/__tests__/api/me-google-routes.test.ts`

**Do NOT** create a shared helper file unless you find ≥3 lines of code duplicated across all four routes. Even then, prefer local helpers per route.

## Interface contract

### `GET /api/me/google/connect`

- Auth: `requireSession`. 401 if not signed in.
- Generate `state = randomBytes(32).toString('hex')` (use `node:crypto`).
- Set cookie `google_oauth_state`:
  - `httpOnly: true`, `secure: true` (in prod; relax in dev when `process.env.NODE_ENV !== 'production'`), `sameSite: 'lax'`, `path: '/api/me/google/callback'`, `maxAge: 600` (10 min)
- 302 → `buildConsentUrl(session.userId, state)`

### `GET /api/me/google/callback`

- Read `code` and `state` from query params.
- Read the `google_oauth_state` cookie.
- **E18 / AC-17:** if cookie missing OR `state !== cookie value` → clear the cookie and 400 with `{ error: 'STATE_MISMATCH' }`. **Do not call `exchangeCode`.**
- Clear the state cookie unconditionally on the way out (single-use).
- Auth: `requireSession` (returns 401 if the user's session died mid-flow).
- Call `exchangeCode(code)`:
  - On `InsufficientScopesError` → 400 `{ error: 'INSUFFICIENT_SCOPES', missing: [...] }`. **No credential stored** (AC-14).
  - On other errors → 502 `{ error: 'OAUTH_EXCHANGE_FAILED' }`.
- Persist `GoogleCredential`:
  - `userId = session.userId`
  - `accessToken = result.accessToken`
  - `refreshTokenEncrypted = encryptSecret(result.refreshToken)`
  - `accessTokenExpiresAt = result.expiresAt`
  - `googleEmail = result.email`
  - `googleSub = result.sub`
  - `scopes = result.scopes.join(' ')`
  - `lastUsedAt = null`
  - `updatedAt = now` (Prisma auto-handles via `@updatedAt`)
- Use Prisma `upsert` keyed on `userId` so a re-consent replaces the existing row atomically.
- If a *different* `userId` already has the same `googleSub` (Google identity collision — user re-uses a Google account on a second kanban account): 409 `{ error: 'GOOGLE_ACCOUNT_BOUND_TO_OTHER_USER' }`. **No row written.**
- 302 → `/settings/integrations?connected=1`

### `DELETE /api/me/google/disconnect` (AC-2)

- Auth: `requireSession`. 401 if absent.
- Load `GoogleCredential` for `userId`. If absent → 204 (idempotent; no error).
- Call `revokeRefreshToken(userId)` (best-effort; ignores network failures).
- `prisma.googleCredential.delete({ where: { userId } })`.
- 204 (No Content).

### `GET /api/me/google/status`

```ts
type StatusResponse =
  | { connected: false }
  | {
      connected: true
      email: string
      scopes: string[]                // split on whitespace
      lastUsedAt: string | null       // ISO
      expired: boolean                // accessTokenExpiresAt < now AND access token cleared (TokenRevokedError aftermath)
    }
```

- Auth: `requireSession`. 401 if absent.
- Read the row. If absent → `{ connected: false }`.
- `expired` true iff `accessToken === null AND accessTokenExpiresAt === null` (the spec-defined "expired-reconnect" state set by `refreshAccessToken` on `invalid_grant`).
- Response shape exactly per the type above.

## Hard rules

1. **No service-layer abstraction.** These are four routes; keep them small. Resist creating `src/lib/google/routes-helpers.ts`.
2. **State generation is local to the connect route** (`randomBytes(32).toString('hex')`). Do not centralise — there's only one consumer.
3. **Never** include the access token, refresh token, or `googleEmail` in any error response body. `email` is fine in `status` (the user already knows their own email).
4. The callback must clear the cookie before any branching (`Set-Cookie: ...; Max-Age=0`). Test asserts this.
5. **No `any`.** Type the response bodies via discriminated unions for the status route; type the query/cookie reads explicitly.
6. Functions ≤ 40 lines per route handler. Use small private helpers if the callback grows.
7. Cookie name is exactly `google_oauth_state` (lowercase, underscores). Tests assert this string.
8. For `/connect` and `/callback`, the redirect destination MUST be the values the spec says — do not introduce alternative landing pages.
9. Tests mock `@/lib/google/oauth` (`exchangeCode`, `revokeRefreshToken`, `buildConsentUrl`) with `vi.mock`. No real fetch.

## Tests to write

`/opt/kanban/__tests__/api/me-google-routes.test.ts` — share a `setup()` that signs in a test user and returns `{ session, prisma }`. Use Next 14's testable handler invocation pattern (`POST(req, ctx)`).

### connect (AC-1)
- Unauth → 401
- Auth → 302; `Location` starts with the mocked consent URL; `Set-Cookie` header contains `google_oauth_state=<hex>` with the right attributes
- State value passed to `buildConsentUrl` matches the cookie value

### callback (AC-1, AC-14, AC-17/E18)
- **AC-17 / E18:** request with no cookie + any query state → 400 `STATE_MISMATCH`, `exchangeCode` NOT called
- **AC-17:** cookie `s1`, query `s2` → 400 `STATE_MISMATCH`, `exchangeCode` NOT called
- Happy path: cookie matches query, `exchangeCode` returns the four required scopes → `googleCredential` row created with encrypted refreshToken (decrypt round-trip equals the plaintext). Response is 302 to `/settings/integrations?connected=1`. The state cookie is cleared in the response (Set-Cookie Max-Age=0)
- **AC-14:** `exchangeCode` throws `InsufficientScopesError(['…documents.readonly'])` → 400 with body `{ error: 'INSUFFICIENT_SCOPES', missing: [...] }`. No row in DB.
- `exchangeCode` throws generic Error → 502
- Replay of upsert: existing row for same userId is overwritten (assert `refreshTokenEncrypted` is now the new value)
- Different userId tries to re-bind the same `googleSub` → 409 `GOOGLE_ACCOUNT_BOUND_TO_OTHER_USER`; original row untouched

### disconnect (AC-2)
- Unauth → 401
- Row present → `revokeRefreshToken` called once; row deleted; 204
- Row absent → 204 (idempotent), `revokeRefreshToken` NOT called
- `revokeRefreshToken` rejects with network error → still 204; row still deleted (best-effort revoke)

### status (AC-13, AC-16)
- Unauth → 401
- No row → `{ connected: false }`
- Row with valid accessToken + future expiry → `{ connected: true, email, scopes, lastUsedAt, expired: false }`
- **AC-16:** row with `accessToken=null AND accessTokenExpiresAt=null` (the post-`invalid_grant` state from Task 01) → `expired: true`
- `scopes` is parsed correctly from the space-separated string

## Verification gate (all must pass)

- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32) GOOGLE_OAUTH_CLIENT_ID=test GOOGLE_OAUTH_CLIENT_SECRET=test GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/me/google/callback npx vitest run __tests__/api/me-google-routes.test.ts`
- Full suite: `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — full or partial

- **AC-1** (OAuth happy path: row stored after consent) — full responsibility
- **AC-2** (Disconnect: row deleted, revoke called) — full responsibility
- **AC-13** (Disconnected user, prior reviews preserved) — partial; this task ensures `status` reports false; review-attempt 401 is in Task 06
- **AC-14** (Missing scope refused) — full responsibility at the callback layer
- **AC-16** (Status shows "Expired — Reconnect") — full responsibility for the status payload; UI in Task 09
- **AC-17 / E18** (CSRF state mismatch) — full responsibility

## Out of scope

- The UI that calls these routes — Task 09
- The card-attach route — Task 06
- The rate-limiter — Task 11

## Live-credential note

These routes are exercisable with the mock layer (`__setGoogleFetchForTests` from Task 01). To verify end-to-end against real Google in the morning, Brad must set:

```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://<host>/api/me/google/callback
```

…and register `<host>/api/me/google/callback` as an authorized redirect URI in the Google Cloud Console OAuth client. No code change required to flip live.

## Done when

- All four routes implemented.
- All route tests pass.
- Single commit on `feat/m4-05-oauth-routes`.

## Escalate if

- Next 14 cookies API in `NextResponse` behaves differently for redirect responses than for JSON — the test must verify `Set-Cookie` survives the 302. If it doesn't, restructure to a 200 + meta-refresh and document.
- `prisma.googleCredential.upsert` with the `userId` unique key collides with the `googleSub` unique constraint in a way that throws a non-`P2002` Prisma error — investigate before catching.
