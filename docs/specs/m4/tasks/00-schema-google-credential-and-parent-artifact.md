# Task 00 — Prisma schema: GoogleCredential model + Artifact.parentArtifactId self-relation

**Agent type:** coder
**Depends on:** none (schema-only, lands first)
**Runs before:** every other M4 task
**Spec sections:** M4 spec — "Prisma schema additions", "Additional schema for E6", AC-20

---

## Goal

Add the `GoogleCredential` model and the nullable `parentArtifactId` self-relation on `Artifact` to the Prisma schema. Generate a single forward-only SQLite migration. No application code changes downstream. After this task lands, `prisma migrate deploy` against the live DB must leave existing rows in `users`, `cards`, `artifacts`, `ai_reviews` untouched.

## Inputs — files to read first

- `/opt/kanban/prisma/schema.prisma` — locate the existing `User` model (add the back-relation), the existing `Artifact` model (add self-relation fields), and the trailing reserved-source comment (M4 implements those values)
- `/opt/kanban/prisma/migrations/20260521000000_m4_org_ai_settings/` — pattern for an additive SQLite migration that creates a new table and is safe on a populated DB
- `/opt/kanban/docs/specs/m4-external-doc-review.md` — schema block and acceptance criterion 20

## Files to create / modify

**Modify:**

- `/opt/kanban/prisma/schema.prisma` — add `GoogleCredential` model; add `parentArtifactId`, `parent`, `children` to `Artifact`; add `googleCredential GoogleCredential?` back-relation on `User`

**Create:**

- `/opt/kanban/prisma/migrations/20260522000000_m4_google_credentials/migration.sql` — additive: `CREATE TABLE google_credentials`, `ALTER TABLE artifacts ADD COLUMN parentArtifactId TEXT REFERENCES artifacts(id) ON DELETE SET NULL`, plus the indexes below

**Do NOT** touch any existing `ai_reviews`, `cards`, or `users` columns. Do not rename columns. Do not add data backfills.

## Interface contract

Append exactly this to `schema.prisma`:

```prisma
model GoogleCredential {
  userId                String   @id
  user                  User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  accessToken           String?
  refreshTokenEncrypted String   // ciphertext only — never log
  accessTokenExpiresAt  DateTime?

  googleEmail           String
  googleSub             String   @unique
  scopes                String   // space-separated

  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  lastUsedAt            DateTime?

  @@map("google_credentials")
}
```

Add to `User`:

```prisma
googleCredential GoogleCredential?
```

Modify `Artifact`:

```prisma
parentArtifactId String?
parent           Artifact?  @relation("ArtifactChildren", fields: [parentArtifactId], references: [id], onDelete: SetNull)
children         Artifact[] @relation("ArtifactChildren")

@@index([parentArtifactId])
```

(Keep the existing `@@index([cardId])` and the trailing source comment. Add the new index alongside.)

## Migration SQL (verbatim shape — coder may reformat but not reorder)

```sql
-- CreateTable
CREATE TABLE "google_credentials" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "accessToken" TEXT,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "accessTokenExpiresAt" DATETIME,
    "googleEmail" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    CONSTRAINT "google_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "google_credentials_googleSub_key" ON "google_credentials"("googleSub");

-- AlterTable: nullable column, no default beyond NULL, no data backfill needed
ALTER TABLE "artifacts" ADD COLUMN "parentArtifactId" TEXT REFERENCES "artifacts"("id") ON DELETE SET NULL;

-- CreateIndex
CREATE INDEX "artifacts_parentArtifactId_idx" ON "artifacts"("parentArtifactId");
```

## Hard rules

1. Schema-only. No imports of these types into TS code in this PR — that lands in later tasks.
2. **No** `npx prisma migrate dev` against a populated DB in CI. The migration is generated, named, and committed; deploy is the gate.
3. New column is **nullable** with NO default value. Existing rows must remain unaffected (AC-20).
4. Do not edit the existing reserved-source comment on `Artifact.source`. Leave the comment; we implement the values in later tasks but do not change the schema string.
5. The `refreshTokenEncrypted` column is plain `TEXT` in DB — encryption is at the application layer via `src/lib/secrets.ts`. Do not add DB-level encryption.
6. `googleSub` must be `@unique` (one row per Google identity globally) AND the primary key is `userId` (one credential per kanban user). Both invariants hold simultaneously.

## Tests to write

- `/opt/kanban/__tests__/prisma/m4-schema.test.ts`
  - **AC-20 (migration safety):** start from an empty SQLite DB, seed one row into `users`, `cards`, `artifacts`, `ai_reviews`; run `prisma migrate deploy`; assert all four rows still present and unmodified after migration. Assert `google_credentials` table exists and is empty. Assert `parentArtifactId` column exists on `artifacts` and is NULL on the seeded row.
  - **Self-relation works:** create an Artifact A and an Artifact B with `parentArtifactId = A.id`; load A with `include: { children: true }`; expect `[B]`. Load B with `include: { parent: true }`; expect A.
  - **Cascade on User delete:** create a User with a `GoogleCredential`; delete the User; expect the credential row gone (CASCADE).
  - **SetNull on parent Artifact delete:** delete A from above; expect B still exists with `parentArtifactId = null` (SET NULL).
  - **`googleSub` uniqueness:** attempt to insert two `GoogleCredential` rows with the same `googleSub` for different users; expect a Prisma error.

Use a fresh DB per test (`DATABASE_URL=file:/tmp/m4-schema-<random>.db` + `prisma migrate deploy`). Do not pollute the main dev DB.

## Verification gate (all must pass)

- `cd /opt/kanban && npx prisma format` — schema must be canonically formatted
- `cd /opt/kanban && npx prisma validate` — no validation errors
- `cd /opt/kanban && rm -f /tmp/m4-00.db && DATABASE_URL=file:/tmp/m4-00.db npx prisma migrate deploy` — clean deploy succeeds
- `cd /opt/kanban && npx tsc --noEmit`
- `cd /opt/kanban && npx eslint . --max-warnings 0`
- `cd /opt/kanban && SESSION_SECRET=test-secret DATABASE_URL=file:./kanban.db npx vitest run`
- `cd /opt/kanban && npm run build`

## Acceptance criteria from M4 spec satisfied here

- **AC-20** (Migration safe) — full responsibility.
- Partial groundwork for AC-1 (credential row exists), AC-7 (parentArtifactId on folder children), AC-15 (refreshTokenEncrypted column present). Full ACs land in later tasks.

## Done when

- `schema.prisma` contains the two additions above and `npx prisma format && npx prisma validate` exit clean.
- Migration file exists, deploys cleanly on an empty DB, and on a DB with pre-existing rows leaves them untouched.
- The five schema tests above pass.
- Single commit on `feat/m4-00-schema`.

## Escalate if

- The existing `Artifact.source` comment turns out to be more authoritative than the schema (i.e., a Zod or TS union pins the values elsewhere) — flag before editing.
- `prisma format` reorders other parts of the schema unexpectedly — show Brad the diff before merging.
