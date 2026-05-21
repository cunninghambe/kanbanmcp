-- CreateTable: card_executions
-- CardExecutionState is stored as TEXT (SQLite has no native enum; Prisma client enforces valid values).
CREATE TABLE "card_executions" (
    "id"           TEXT     NOT NULL PRIMARY KEY,
    "cardId"       TEXT     NOT NULL,
    "jobId"        TEXT,
    "state"        TEXT     NOT NULL,
    "project"      TEXT     NOT NULL,
    "branch"       TEXT     NOT NULL,
    "spec"         TEXT     NOT NULL,
    "output"       TEXT,
    "errorMessage" TEXT,
    "enqueuedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt"    DATETIME,
    "finishedAt"   DATETIME,
    CONSTRAINT "card_executions_cardId_fkey"
        FOREIGN KEY ("cardId") REFERENCES "cards" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "card_executions_cardId_idx" ON "card_executions"("cardId");

-- CreateIndex
CREATE INDEX "card_executions_state_idx" ON "card_executions"("state");

-- Seed: insert a "Blocked" column for every board that does not already have one
-- (case-insensitive check). Uses lower(hex(randomblob(12))) to generate a
-- unique 24-hex-char TEXT id — matches the TEXT PRIMARY KEY type on columns.
INSERT INTO "columns" ("id", "name", "boardId", "position")
SELECT
    lower(hex(randomblob(12))),
    'Blocked',
    boards.id,
    (SELECT COALESCE(MAX(c2.position), -1) + 1 FROM "columns" c2 WHERE c2."boardId" = boards.id)
FROM "boards"
WHERE NOT EXISTS (
    SELECT 1 FROM "columns" c3
    WHERE c3."boardId" = boards.id
      AND lower(c3."name") = 'blocked'
);
