# Task 01 — `src/lib/google/oauth.ts`: consent URL, code exchange, refresh flow, error hierarchy

**Agent type:** coder
**Depends on:** 00-schema
**Spec sections:** M4 spec — "New module: src/lib/google/" (oauth.ts block), E2, E15, E18, E19, E22, AC-1, AC-2, AC-3, AC-14, AC-15, AC-16, AC-17, AC-19

---

## Goal

Implement the OAuth lifecycle building blocks: a deterministic Google consent URL builder, an authorization-code exchange that yields tokens + identity + granted scopes, and a refresh flow that reads encrypted credentials from `GoogleCredential`, refreshes via Google's token endpoint, persists rotated refresh tokens, and surfaces revocation as a typed error. All HTTP calls go through `fetch` and are stubbable in tests — no live network, no `googleapis` SDK.

## Inputs — files to read first

- `/opt/kanban/src/lib/secrets.ts` — `encryptSecret`, `decryptSecret` (the **only** crypto helper allowed in M4)
- `/opt/kanban/src/lib/db.ts` — `prisma` import
- `/opt/kanban/prisma/schema.prisma` — `GoogleCredential` model from Task 00
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — `src/lib/google/oauth.ts` contract block + E2, E15, E18, E19, E22 + AC-1, AC-2, AC-3, AC-14, AC-15, AC-16, AC-17, AC-19

## Files to create / modify

**Create:**

- `/opt/kanban/src/lib/google/oauth.ts` — public API below
- `/opt/kanban/src/lib/google/errors.ts` — error class hierarchy (shared by drive/docs/sheets/slides)
- `/opt/kanban/src/lib/google/fetch.ts` — single typed `fetch` wrapper for tests to stub; **all** Google HTTP goes through this in every M4 file
- `/opt/kanban/__tests__/lib/google/oauth.test.ts`

**Do NOT modify** anything outside `src/lib/google/` in this task. Routes that use these functions land in Task 07.

## Interface contract

### `src/lib/google/errors.ts`

```ts
export class GoogleAuthExpiredError extends Error {
  readonly code = 'GOOGLE_AUTH_EXPIRED' as const
}
export class TokenRevokedError extends Error {
  readonly code = 'TOKEN_REVOKED' as const
}
export class InsufficientScopesError extends Error {
  readonly code = 'INSUFFICIENT_SCOPES' as const
  constructor(public readonly missing: string[]) { super(`Missing scopes: ${missing.join(', ')}`) }
}
export class StateMismatchError extends Error {
  readonly code = 'STATE_MISMATCH' as const
}
export class GoogleHttpError extends Error {
  readonly code = 'GOOGLE_HTTP_ERROR' as const
  constructor(public readonly status: number, public readonly body: string) { super(`Google HTTP ${status}`) }
}
```

### `src/lib/google/fetch.ts`

```ts
// A thin, mockable wrapper. Default implementation calls global `fetch`.
// Tests override via __setGoogleFetchForTests.
export type GoogleFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; ok: boolean; text: () => Promise<string>; json: () => Promise<unknown> }>

export function googleFetch(...args: Parameters<GoogleFetch>): ReturnType<GoogleFetch>
export function __setGoogleFetchForTests(impl: GoogleFetch | null): void
```

### `src/lib/google/oauth.ts`

```ts
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
] as const

export function buildConsentUrl(userId: string, state: string): string
// Reads GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_REDIRECT_URI, optional GOOGLE_SCOPES_OVERRIDE.
// Returns the full https://accounts.google.com/o/oauth2/v2/auth?... URL with
// access_type=offline, prompt=consent, include_granted_scopes=true,
// state=<state>, login_hint omitted, scope=<space-joined REQUIRED_SCOPES>.

export interface ExchangeResult {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  email: string
  sub: string
  scopes: string[]   // granted, parsed from response.scope (space-split)
}
export async function exchangeCode(code: string): Promise<ExchangeResult>
// POST to https://oauth2.googleapis.com/token with grant_type=authorization_code.
// Then GET https://openidconnect.googleapis.com/v1/userinfo with Bearer to fetch
// { email, sub }. If response.scope is missing any REQUIRED_SCOPES → throw
// InsufficientScopesError(missing).

export async function refreshAccessToken(userId: string): Promise<string>
// 1. Load GoogleCredential by userId. If row missing → throw GoogleAuthExpiredError.
// 2. Decrypt refreshTokenEncrypted via decryptSecret.
// 3. POST oauth2.googleapis.com/token with grant_type=refresh_token.
// 4. On 400 + error='invalid_grant':
//      - Clear accessToken and accessTokenExpiresAt on the row (keep row + refreshTokenEncrypted unchanged
//        so the UI can show "Expired — Reconnect"); throw TokenRevokedError.
//      - Per spec wording: "Wipe accessToken/accessTokenExpiresAt from the row but keep the row".
// 5. On success: update row with new accessToken, accessTokenExpiresAt, lastUsedAt=now.
//    If response includes a new refresh_token, re-encrypt and store (E22).
// 6. Return the fresh accessToken.

export async function revokeRefreshToken(userId: string): Promise<void>
// POST https://oauth2.googleapis.com/revoke?token=<decrypted refresh token>.
// Best effort: ignore 200 vs 400 — Google returns 400 if the token is already invalid,
// which is the same desired state. Caller is expected to delete the GoogleCredential
// row after this returns. Does NOT delete the row itself (separation of concerns).

export async function ensureFreshAccessToken(userId: string): Promise<string>
// If the row's accessToken exists and accessTokenExpiresAt > now + 30s, return it.
// Otherwise call refreshAccessToken(userId).
```

## Hard rules

1. **No `googleapis` SDK.** All HTTP via `googleFetch`. Keeps the dep tree light and the test surface mockable.
2. **No new crypto.** Use `encryptSecret` / `decryptSecret` from `src/lib/secrets.ts`. If you find yourself reaching for `node:crypto`, stop.
3. **Never log** `refreshToken` (plaintext or ciphertext), `accessToken`, the client secret, or the encryption key. Test asserts this (AC-19).
4. State parameter on `buildConsentUrl` is the caller's responsibility — this function does not generate one. The route handler in Task 07 generates and cookies it.
5. Reading env: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`. If any missing at call time (not at module load), throw a clear `Error('GOOGLE_OAUTH_* env vars not configured')`. Do not throw at module load — tests need to import without env.
6. `SETTINGS_ENCRYPTION_KEY` must be present (it already gates `secrets.ts`). Do not duplicate the check.
7. Functions ≤ 40 lines each. Extract helpers if needed.
8. **No `any`.** Use `unknown` + narrowing for JSON shapes. Use a Zod schema or a hand-written type guard for token + userinfo responses.

## Tests to write

`/opt/kanban/__tests__/lib/google/oauth.test.ts` — use `__setGoogleFetchForTests` to stub all responses. Each `it` block clears the stub in `afterEach`.

- **buildConsentUrl**
  - Returns a URL starting with `https://accounts.google.com/o/oauth2/v2/auth?`
  - Includes `access_type=offline`, `prompt=consent`, `response_type=code`, `include_granted_scopes=true`
  - Includes `client_id` from env and `redirect_uri` from env (URL-encoded)
  - Includes all four `REQUIRED_SCOPES` joined by `+` (space-encoded)
  - State param is exactly the value passed in (not modified)
  - `GOOGLE_SCOPES_OVERRIDE='a b'` env returns that scope list instead

- **exchangeCode** (AC-1, AC-14, AC-19)
  - Happy path: token endpoint returns `{ access_token, refresh_token, expires_in: 3600, scope: '<all four>', id_token: ... }`; userinfo returns `{ email, sub }` → resolves to fully populated `ExchangeResult`
  - Token endpoint 400 → throws `GoogleHttpError`
  - **AC-14:** scope response missing `documents.readonly` → throws `InsufficientScopesError` with `missing = ['…documents.readonly']`; no userinfo call made
  - Token endpoint sets `expires_in: 3600` → returned `expiresAt` is ~now+3600s (use fake timers; assert ±1s)

- **refreshAccessToken** (AC-3, AC-15, AC-16, E2, E22)
  - **AC-3:** stored row + valid stub → returns new accessToken; row updated with new accessToken + expiresAt + lastUsedAt
  - **AC-15:** stub returns new `refresh_token` → row's `refreshTokenEncrypted` re-encrypted; `decryptSecret` on the new value equals the new refresh token
  - **AC-16 / E2:** stub returns 400 with body `{ error: 'invalid_grant' }` → throws `TokenRevokedError`; row's `accessToken` and `accessTokenExpiresAt` are now null but row still exists with `refreshTokenEncrypted` unchanged
  - Row missing → throws `GoogleAuthExpiredError`

- **ensureFreshAccessToken** (E15)
  - Row with accessToken expiring in 10 minutes → returns existing accessToken, no fetch made
  - Row with accessToken expiring in 10 seconds → triggers refresh; returns refreshed token
  - Row with null accessToken → triggers refresh

- **revokeRefreshToken**
  - 200 → resolves
  - 400 → resolves (best-effort; Google returns 400 on already-invalid tokens)
  - Network throw → resolves without rethrowing (best-effort; documented in code comment)

- **No-leak guarantee (AC-19)**
  - Wrap `console.log/warn/error` with a vi.fn() spy for the duration of the happy-path exchange + refresh + revoke runs; assert none of the spied calls' string-joined arguments contain the plaintext refresh token, plaintext access token, or `process.env.GOOGLE_OAUTH_CLIENT_SECRET`.

## Verification gate (all must pass)

- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32) GOOGLE_OAUTH_CLIENT_ID=test-id GOOGLE_OAUTH_CLIENT_SECRET=test-secret GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/me/google/callback npx vitest run __tests__/lib/google/oauth.test.ts`
- Full suite: `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec — partial responsibility

- **AC-1** (credential row stored after consent) — token mechanics; route in Task 07 closes the loop
- **AC-3** (silent refresh) — full responsibility
- **AC-14** (missing scope refused) — `InsufficientScopesError` raised by `exchangeCode`
- **AC-15** (rotation persisted) — full responsibility
- **AC-16** (revoked token surfaces `TokenRevokedError`) — full responsibility
- **AC-19** (refresh token never logged) — full responsibility within this module's surface

## Out of scope

- The HTTP routes (`/api/me/google/*`) — Task 07
- Rate-limiter integration — Task 11
- UI affordances — Task 09

## Done when

- All public functions implemented with the exact signatures above.
- All tests above pass; coverage of `oauth.ts` ≥ 90% lines per `vitest --coverage` (informational, not a hard gate).
- No file outside `src/lib/google/` modified.
- Single commit on `feat/m4-01-oauth`.

## Escalate if

- The `oauth2.googleapis.com/token` response wraps `refresh_token` inside an envelope (Google docs change) — capture the actual shape in code comments before adapting.
- `decryptSecret` throws unexpectedly on a freshly-encrypted value (would mean key drift between encrypt + decrypt) — stop, do not paper over.
