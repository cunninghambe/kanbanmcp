-- CreateTable: org_ai_settings
CREATE TABLE "org_ai_settings" (
    "id"                       TEXT     NOT NULL PRIMARY KEY,
    "orgId"                    TEXT     NOT NULL,
    "anthropicApiKeyEncrypted" TEXT,
    "anthropicApiKeyLastFour"  TEXT,
    "createdAt"                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                DATETIME NOT NULL,
    CONSTRAINT "org_ai_settings_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "org_ai_settings_orgId_key" ON "org_ai_settings"("orgId");
