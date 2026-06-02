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
