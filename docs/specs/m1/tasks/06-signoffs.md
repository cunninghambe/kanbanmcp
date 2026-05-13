# Task 06 — Signoffs API

**Agent type:** coder
**Depends on:** 01-schema, 02-card-api
**Spec sections:** §4.6 (Signoffs), §7 AC-7, §6 E6/E15

---

## Goal

Add the signoff endpoints: `POST /api/cards/[cardId]/signoffs` (record a decision) and `GET /api/cards/[cardId]/signoffs` (list, with derived "latest per role"). Only the card's assigned reviewer can record `role=REVIEWER`; only the assigned approver can record `role=APPROVER`. Signoffs are append-only history — multiple submissions over time are allowed and listed.

## Inputs — files to read first

- `/root/kanbanmcp/src/app/api/cards/[cardId]/route.ts` — auth/resolve pattern
- `/root/kanbanmcp/src/lib/api-helpers.ts`
- `/root/kanbanmcp/prisma/schema.prisma` post Task 01 — `Signoff` model
- M1 spec §4.6, §7 AC-7, §6 E6/E15

## Files to create

- `/root/kanbanmcp/src/app/api/cards/[cardId]/signoffs/route.ts` — POST + GET

## Files to modify

- None. (Card-level inclusion of `signoffs[latest per role]` is the responsibility of the children endpoint, owned by Task 03; the single-card GET does not include signoffs to keep payloads small. Clients call `GET /signoffs` separately.)

## Interface contract

### Zod schema

```ts
const VALID_ROLES = ['REVIEWER', 'APPROVER'] as const
const VALID_DECISIONS = ['APPROVED', 'REJECTED', 'REQUESTED_CHANGES'] as const

const createSignoffSchema = z.object({
  role: z.enum(VALID_ROLES),
  decision: z.enum(VALID_DECISIONS),
  comment: z.string().max(2000).optional(),
})
```

### POST handler

- Auth: `requireSession`, `resolveCard` (org check), `requireOrgRole(MEMBER)`.
- Re-fetch the card with `reviewerId` and `approverId` selected (the `resolveCard` helper from `cards/[cardId]/route.ts` is private — duplicate the resolution here or extract it to `src/lib/api-helpers.ts` in this task; **decision: keep duplication; do not refactor in this task**).
- Validate body with `createSignoffSchema`. Standard 400 envelope on failure.
- Role-specific authorisation:
  - If `body.role === 'REVIEWER'`:
    - If `card.reviewerId === null` → 400 with `{ error: 'No reviewer assigned' }` (E15)
    - If `card.reviewerId !== session.userId` → 403 with `{ error: 'Only the assigned reviewer may sign off as REVIEWER' }` (AC-7, E6)
  - If `body.role === 'APPROVER'`:
    - If `card.approverId === null` → 400 with `{ error: 'No approver assigned' }`
    - If `card.approverId !== session.userId` → 403 with `{ error: 'Only the assigned approver may sign off as APPROVER' }`
- **API-key auth path:** `session.userId` is an empty string for API-key auth, which can never equal `reviewerId`. → 403. Document this — API keys cannot submit signoffs. (Reasonable: signoffs are a human decision.)
- Insert: `prisma.signoff.create({ data: { cardId: params.cardId, userId: session.userId, role, decision, comment: comment ?? null } })`
- Response: 201 with `{ signoff: <shaped> }`

### GET handler

- Auth: same.
- Query param `?latestPerRole=true` (optional, default false):
  - false: returns all signoffs for the card, ordered `createdAt DESC`
  - true: returns at most 2 rows — the latest signoff for each role
- Response: `{ signoffs: SignoffResponse[] }`, optionally `{ latest: { reviewer: SignoffResponse | null, approver: SignoffResponse | null } }` when `latestPerRole=true`.

### Response shape

```ts
interface SignoffResponse {
  id: string
  cardId: string
  role: 'REVIEWER' | 'APPROVER'
  decision: 'APPROVED' | 'REJECTED' | 'REQUESTED_CHANGES'
  comment: string | null
  createdAt: string // ISO
  user: { id: string; name: string; email: string }
}
```

## Implementation notes

1. **Latest-per-role query.** Two `findFirst` queries with `orderBy: { createdAt: 'desc' }` filtered by `role`. Simpler than a window function over SQLite.
2. **Idempotency.** Spec explicitly permits multiple signoffs over time. Do NOT dedupe; do NOT update existing rows. Append-only.
3. **Comment cap.** 2000 chars — adjust if downstream UI needs more, but matches typical comment-box sizes.
4. **Resolve helper duplication.** `resolveCard` in `cards/[cardId]/route.ts` is private. Re-implement the same 4-line lookup inline here; refactoring to shared helper is a separate concern. Keep the duplication explicit with a `// duplicated from cards/[cardId]/route.ts to avoid premature abstraction` comment.
5. **No automatic side effects.** A signoff does not change the card status, move columns, or post a comment. Advisory only per §2.

## Acceptance criteria

- **AC-7:** A user who is neither `reviewerId` nor `approverId` on the card receives 403 on `POST`.
- **E6:** Reviewer attempting `role=APPROVER` → 403 (they may sign off only as REVIEWER even though they're a reviewer).
- **E15:** Submitting `role=REVIEWER` on a card with `reviewerId=null` → 400 "No reviewer assigned".
- Multiple signoffs by the same reviewer over time are all retained; `GET /signoffs` returns them all.
- `GET /signoffs?latestPerRole=true` returns at most 2 — one per role, the most recent.
- API-key authenticated requests → 403 (cannot impersonate a human reviewer).
- Invalid `role` or `decision` → 400 with Zod issues.
- `npx tsc --noEmit` passes.

## Tests to write

- `/root/kanbanmcp/__tests__/api/signoffs.test.ts`
  - Reviewer signoff success → 201, row created
  - Approver signoff success → 201
  - Non-reviewer non-approver → 403 (AC-7)
  - Reviewer attempting APPROVER role → 403 (E6)
  - REVIEWER role on card with null reviewerId → 400 (E15)
  - Invalid decision → 400
  - API-key auth → 403
  - GET with `latestPerRole=true` returns latest per role
  - GET without param returns all, newest first

Mock `@/lib/db` per existing pattern.

## Out of scope for this task

- Column-transition gating (explicit §2 exclusion)
- Notification on signoff creation
- MCP `record_signoff` tool (Task 07)
- UI signoff buttons (Task 08)
- Webhook payload changes (deferred to M3)

## Done when

- Routes exist; tests pass; `npx tsc --noEmit` passes.
- Single commit on `feat/m1-review-workflow`.
