-- RedefineTables: make artifactId nullable, add cardId to ai_reviews
-- SQLite does not support ALTER COLUMN, so we rebuild the table.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ai_reviews" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "artifactId"     TEXT,
    "cardId"         TEXT NOT NULL DEFAULT 'MIGRATED',
    "status"         TEXT NOT NULL DEFAULT 'pending',
    "model"          TEXT NOT NULL,
    "rubricSnapshot" TEXT NOT NULL,
    "instructions"   TEXT,
    "output"         TEXT,
    "errorMessage"   TEXT,
    "inputTokens"    INTEGER,
    "outputTokens"   INTEGER,
    "startedAt"      DATETIME,
    "finishedAt"     DATETIME,
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_reviews_artifactId_fkey"
        FOREIGN KEY ("artifactId") REFERENCES "artifacts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ai_reviews_cardId_fkey"
        FOREIGN KEY ("cardId") REFERENCES "cards" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ai_reviews" (
    "id", "artifactId", "cardId", "status", "model", "rubricSnapshot",
    "instructions", "output", "errorMessage", "inputTokens", "outputTokens",
    "startedAt", "finishedAt", "createdAt"
)
SELECT
    r."id",
    r."artifactId",
    COALESCE(a."cardId", 'MIGRATED'),
    r."status",
    r."model",
    r."rubricSnapshot",
    r."instructions",
    r."output",
    r."errorMessage",
    r."inputTokens",
    r."outputTokens",
    r."startedAt",
    r."finishedAt",
    r."createdAt"
FROM "ai_reviews" r
LEFT JOIN "artifacts" a ON a."id" = r."artifactId";

DROP TABLE "ai_reviews";
ALTER TABLE "new_ai_reviews" RENAME TO "ai_reviews";

CREATE INDEX "ai_reviews_artifactId_idx" ON "ai_reviews"("artifactId");
CREATE INDEX "ai_reviews_cardId_idx"     ON "ai_reviews"("cardId");
CREATE INDEX "ai_reviews_status_idx"     ON "ai_reviews"("status");

PRAGMA foreign_keys=ON;
