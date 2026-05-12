# Task 01 — Schema, Migration, Backfill, AI Reviewer Seed

**Agent type:** coder
**Depends on:** none
**Spec sections:** §3 (Schema Changes), §7 (AC-1, AC-2, AC-3), §8 (Architecture Decisions: `assigneeId` location, JSON-as-string, Reviewer identity)

---

## Goal

Extend the Prisma schema with the M1 review-workflow fields and models (sub-cards, reviewer/approver, AI review params, artifacts, signoffs, AI reviews), generate the migration, backfill nullable `assigneeId` rows to `createdById` via raw SQL inside the migration, and add an idempotent seed script that ensures an "AI Reviewer" service `User` exists for the worker to post comments as. Everything else in M1 depends on this task — no application code in this brief.

## Inputs — files to read first

- `/root/kanbanmcp/prisma/schema.prisma` — current schema (you are appending and modifying `Card` + `User`)
- `/root/kanbanmcp/prisma/seed.ts` — pattern for seed scripts (uses `PrismaClient`, plain script, `bcryptjs`)
- `/root/kanbanmcp/prisma/migrations/20260405112251_add_helpdesk_tickets/` — example of an existing migration to follow style (raw SQL)
- `/root/kanbanmcp/package.json` — npm script wiring; you will add a new script
- M1 spec §3 (schema), §6 E1 (resolved: eager recompute on delete), §7 AC-1/2/3, §8

## Files to create / modify

**Modify:**
- `/root/kanbanmcp/prisma/schema.prisma` — add fields to `Card`, add `Artifact`, `AiReview`, `Signoff` models, add inverse relations to `User`
- `/root/kanbanmcp/prisma/seed.ts` — invoke the new AI Reviewer seed helper at the end of `main()` so dev DBs always have the row (idempotent)
- `/root/kanbanmcp/package.json` — add `"db:seed-ai-reviewer": "ts-node --compiler-options '{\"module\":\"CommonJS\"}' prisma/seed-ai-reviewer.ts"`

**Create:**
- `/root/kanbanmcp/prisma/seed-ai-reviewer.ts` — idempotent upsert of the AI Reviewer User; exports a function `ensureAiReviewerUser(prisma): Promise<{ id: string }>` AND runs as a script when invoked directly
- `/root/kanbanmcp/prisma/migrations/<timestamp>_m1_review_workflow/migration.sql` — generated via `prisma migrate dev --name m1_review_workflow --create-only`, then HAND-EDIT to append the backfill `UPDATE` (see Implementation notes)

**Do NOT create:**
- A `seed-ai-reviewer.test.ts` — covered by the seed script being idempotent (re-running must not throw and must not duplicate). A trivial assertion test under `__tests__/prisma/seed-ai-reviewer.test.ts` IS in scope — see "Tests to write".

## Interface contract

### Prisma model deltas

```prisma
model Card {
  // ... existing fields unchanged ...

  reviewerId       String?
  approverId       String?
  parentCardId     String?
  path             String   @default("")  // "/ancestorA/ancestorB/" — empty for root
  depth            Int      @default(0)
  aiAutoReview     Boolean  @default(false)
  aiReviewParams   String?  // JSON string: { model, rubric, customInstructions? }

  reviewer  User?  @relation("CardReviewer", fields: [reviewerId], references: [id])
  approver  User?  @relation("CardApprover", fields: [approverId], references: [id])
  parent    Card?  @relation("CardChildren", fields: [parentCardId], references: [id], onDelete: SetNull)
  children  Card[] @relation("CardChildren")
  artifacts Artifact[]
  signoffs  Signoff[]

  @@index([parentCardId])
  @@index([path])
}

model User {
  // ... existing ...
  reviewedCards     Card[]     @relation("CardReviewer")
  approvedCards     Card[]     @relation("CardApprover")
  uploadedArtifacts Artifact[]
  signoffs          Signoff[]
}

model Artifact {
  id         String   @id @default(cuid())
  cardId     String
  uploaderId String
  filename   String
  mimeType   String
  sizeBytes  Int
  storageKey String
  source     String   @default("UPLOAD")
  createdAt  DateTime @default(now())

  card     Card       @relation(fields: [cardId], references: [id], onDelete: Cascade)
  uploader User       @relation(fields: [uploaderId], references: [id])
  reviews  AiReview[]

  @@index([cardId])
  @@map("artifacts")
}

model AiReview {
  id             String    @id @default(cuid())
  artifactId     String
  status         String    @default("pending") // pending|running|done|failed|skipped
  model          String
  rubricSnapshot String
  instructions   String?
  output         String?
  errorMessage   String?
  inputTokens    Int?
  outputTokens   Int?
  startedAt      DateTime?
  finishedAt     DateTime?
  createdAt      DateTime  @default(now())

  artifact Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)

  @@index([artifactId])
  @@index([status])
  @@map("ai_reviews")
}

model Signoff {
  id        String   @id @default(cuid())
  cardId    String
  userId    String
  role      String   // REVIEWER|APPROVER
  decision  String   // APPROVED|REJECTED|REQUESTED_CHANGES
  comment   String?
  createdAt DateTime @default(now())

  card Card @relation(fields: [cardId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id])

  @@index([cardId])
  @@map("signoffs")
}
```

Add `@@map` to the new models matching the existing project convention (snake_case table names). `Card` already maps to `cards`.

### Seed helper signature

```ts
// prisma/seed-ai-reviewer.ts
import { PrismaClient } from '@prisma/client'

export const AI_REVIEWER_EMAIL = 'ai-reviewer@kanbanmcp.local'
export const AI_REVIEWER_NAME = 'AI Reviewer'

export async function ensureAiReviewerUser(
  prisma: PrismaClient
): Promise<{ id: string; email: string; name: string }>
```

- Uses `prisma.user.upsert({ where: { email: AI_REVIEWER_EMAIL }, update: {}, create: { ... } })`
- `passwordHash` = a deterministic value such as a bcrypt hash of a constant random string captured once and committed (the User can never log in — see Implementation notes; the `passwordHash` column is non-nullable).
- `isAgent: true`
- Logs to stdout: `[seed-ai-reviewer] id=<userId>` so an operator can copy into `.env` if they want the optional override.
- When the file is executed directly (`require.main === module`), instantiates a `PrismaClient`, calls the helper, and disconnects.

## Implementation notes

1. **`@@map` convention.** Existing models use `@@map("snake_case")`. New models follow the same. `Card` is already `@@map("cards")`.
2. **`assigneeId` stays nullable in the DB.** Per AC-2 / §8 row 3. Do **not** add `NOT NULL`. SQLite would require a table rebuild and we already cover the constraint at the API layer (Task 02). Add a comment in `schema.prisma` above the `assigneeId` line: `// Required at the API layer (Zod). DB-nullable for SQLite ALTER COLUMN practicality.`
3. **Backfill via raw SQL appended to the generated `migration.sql`.** After `prisma migrate dev --create-only --name m1_review_workflow`, open the produced `migration.sql` and append:
   ```sql
   -- Backfill: any pre-existing card with NULL assigneeId gets its creator.
   UPDATE "cards" SET "assigneeId" = "createdById" WHERE "assigneeId" IS NULL;
   ```
   Then run `prisma migrate dev` (no flag) to apply it. AC-2 is satisfied at migration time.
4. **AI Reviewer seed location: script, not migration.** The spec wording "seeded at migration time" is reinterpreted here because Prisma migrations are SQL-only and `User.passwordHash` is non-nullable. Acceptable per the architect-resolved assumption recorded in the spec audit. The dev path: `prisma/seed.ts` calls `ensureAiReviewerUser(prisma)` at the end; production deployers can run `npm run db:seed-ai-reviewer` on first boot.
5. **passwordHash for the service user.** Use `await bcrypt.hash('!unusable-' + cuid-string, 12)`. Capture the cuid once and hard-code the resulting hash as a literal in `seed-ai-reviewer.ts` — the User must never be loginable. Document with `// passwordHash is intentionally unusable; this account is for AI-authored comments only.`
6. **Idempotency.** `upsert` on the email unique key. Re-running the seed must not duplicate, must not throw.
7. **No new enums.** SQLite has none. Use `String` for `source`, `status`, `role`, `decision`. Document allowed values in a `// values: ...` schema comment.
8. **Run `npx prisma generate`** after schema edits so the Prisma client picks up new types — but do NOT commit the generated `node_modules/@prisma/client`. Just ensure the migration applies cleanly to a fresh `file:./kanban.db`.
9. **Do not edit the existing `20260405112251_add_helpdesk_tickets` migration.** Generate a new one.

## Acceptance criteria

- **AC-1:** `rm kanban.db && DATABASE_URL=file:./kanban.db npx prisma migrate deploy` (or `migrate dev`) succeeds with the new migration. `npx prisma db pull --print` shows all new tables and indices.
- **AC-2 (partial):** Running `INSERT INTO cards (..., assigneeId=NULL, createdById='u1', ...) ...` then `prisma migrate dev` from the previous state leaves the row with `assigneeId = 'u1'`. The Zod tightening is done in Task 02 — this brief just delivers the migration-side `UPDATE`.
- **AC-3:** `npm run db:seed-ai-reviewer` creates the AI Reviewer User on first run; second run is a no-op. The cuid is printed to stdout. A row exists in `users` with `email = 'ai-reviewer@kanbanmcp.local'`, `isAgent = true`, `name = 'AI Reviewer'`.
- Re-running `prisma migrate deploy` against a DB that already has the migration is a no-op.
- `npx tsc --noEmit` passes.

## Tests to write

- `/root/kanbanmcp/__tests__/prisma/seed-ai-reviewer.test.ts`
  - **Setup:** mock `PrismaClient` with `user.upsert` resolving to a fixed shape.
  - Assert `ensureAiReviewerUser` calls `upsert` with `where: { email: 'ai-reviewer@kanbanmcp.local' }`, `create.isAgent === true`, `create.name === 'AI Reviewer'`, `update === {}`.
  - Assert it returns `{ id, email, name }`.
  - Assert `passwordHash` in the create payload is a non-empty string (no real bcrypt verification needed — just structural).
  - **Do not write a migration integration test** — running `prisma migrate dev` is too slow / stateful for the Vitest suite. AC-1 is verified manually and in CI's lint/build pipeline.

Tests run via `npm test`.

## Out of scope for this task

- API routes (Task 02 onwards)
- The materialised-path recompute helper (Task 03)
- Any Zod schemas at the API layer (Task 02 owns the `assigneeId` tightening)
- AI worker code (Task 05)
- Storage abstraction (Task 04)
- Adding `aiReviewParams` JSON Zod validator — that lives at the API boundary, Task 02

## Done when

- Migration file exists, applies cleanly, and includes the backfill `UPDATE`.
- `seed-ai-reviewer.ts` exists, is idempotent, is invoked from `seed.ts`.
- `npm test` passes (existing tests must still work).
- `npx tsc --noEmit` passes.
- Single commit on `feat/m1-review-workflow`.
