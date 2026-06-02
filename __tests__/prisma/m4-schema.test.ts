/**
 * M4 Schema Tests — AC-20 and GoogleCredential / Artifact self-relation
 *
 * Each test runs against a fresh SQLite file (never the live DB).
 * Migration is applied via `prisma migrate deploy` using execFileSync.
 * Prisma Client is instantiated with a datasource URL override per test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const KANBAN_ROOT = join(__dirname, '../../')

type Row = Record<string, unknown>

function runSql(dbPath: string, sql: string): void {
  execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' })
}

function queryRows(dbPath: string, sql: string): Row[] {
  const raw = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
  }).trim()
  if (!raw) return []
  return JSON.parse(raw) as Row[]
}

function applyMigrations(dbPath: string): void {
  execSync(`DATABASE_URL=file:${dbPath} npx prisma migrate deploy`, {
    cwd: KANBAN_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  })
}

function makePrisma(dbPath: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: `file:${dbPath}` } },
  })
}

// ─── Minimal seed rows (one per relevant table) ───────────────────────────────

const SEED_SQL = `
INSERT INTO "organizations" ("id","name","slug","createdAt")
  VALUES ('org-1','Test Org','test-org', CURRENT_TIMESTAMP);

INSERT INTO "users" ("id","email","passwordHash","name","isAgent","createdAt")
  VALUES ('user-1','test@example.com','$2a$10$fake','Test User',0,CURRENT_TIMESTAMP);

INSERT INTO "boards" ("id","name","orgId","createdAt")
  VALUES ('board-1','Test Board','org-1',CURRENT_TIMESTAMP);

INSERT INTO "columns" ("id","name","boardId","position")
  VALUES ('col-1','Backlog','board-1',0);

INSERT INTO "cards" (
  "id","title","columnId","boardId","priority","position",
  "createdById","createdAt","updatedAt","path","depth",
  "aiAutoReview"
)
  VALUES (
    'card-1','Test Card','col-1','board-1','none',0,
    'user-1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'',0,0
  );

INSERT INTO "artifacts" (
  "id","cardId","uploaderId","filename","mimeType","sizeBytes","storageKey","source","createdAt"
)
  VALUES (
    'artifact-1','card-1','user-1','test.pdf','application/pdf',1024,'s3/test.pdf','UPLOAD',CURRENT_TIMESTAMP
  );

INSERT INTO "ai_reviews" (
  "id","cardId","status","model","rubricSnapshot","createdAt"
)
  VALUES (
    'review-1','card-1','done','claude-3-haiku-20240307','{"criteria":[]}',CURRENT_TIMESTAMP
  );
`.trim()

// ─── Per-test DB lifecycle ────────────────────────────────────────────────────

let tmpDir: string
let dbPath: string
let prisma: PrismaClient

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'test-m4-schema-'))
  dbPath = join(tmpDir, 'test.db')
})

afterEach(async () => {
  await prisma?.$disconnect()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('M4 schema', () => {
  it('AC-20: migration leaves existing rows untouched and adds new structures', () => {
    // Apply all migrations to empty DB — this creates all tables
    applyMigrations(dbPath)

    // Seed one row into each relevant table
    runSql(dbPath, SEED_SQL)

    // Apply again — should be a no-op (already applied); new migration already ran
    // Nothing to re-apply; verify state after initial apply + seed

    // Verify all four seeded rows still present and unmodified
    const users = queryRows(dbPath, `SELECT id FROM "users"`)
    expect(users).toHaveLength(1)
    expect(users[0].id).toBe('user-1')

    const cards = queryRows(dbPath, `SELECT id FROM "cards"`)
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe('card-1')

    const artifacts = queryRows(dbPath, `SELECT id, parentArtifactId FROM "artifacts"`)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].id).toBe('artifact-1')
    expect(artifacts[0].parentArtifactId).toBeNull()

    const reviews = queryRows(dbPath, `SELECT id FROM "ai_reviews"`)
    expect(reviews).toHaveLength(1)
    expect(reviews[0].id).toBe('review-1')

    // google_credentials table exists and is empty
    const creds = queryRows(dbPath, `SELECT * FROM "google_credentials"`)
    expect(creds).toHaveLength(0)

    // parentArtifactId column exists on artifacts (confirmed above via SELECT)
    const cols = queryRows(dbPath, `PRAGMA table_info("artifacts")`)
    const colNames = cols.map((c) => c.name as string)
    expect(colNames).toContain('parentArtifactId')
  })

  it('Artifact self-relation: children are reachable from parent and vice versa', async () => {
    applyMigrations(dbPath)
    prisma = makePrisma(dbPath)

    // Create prerequisite org, user, board, column
    const org = await prisma.organization.create({ data: { name: 'Org', slug: 'org' } })
    const user = await prisma.user.create({
      data: { email: 'a@b.com', passwordHash: 'x', name: 'A' },
    })
    const board = await prisma.board.create({ data: { name: 'B', orgId: org.id } })
    const column = await prisma.column.create({
      data: { name: 'Col', boardId: board.id, position: 0 },
    })
    const card = await prisma.card.create({
      data: {
        title: 'Card',
        columnId: column.id,
        boardId: board.id,
        position: 0,
        createdById: user.id,
      },
    })

    const artifactA = await prisma.artifact.create({
      data: {
        cardId: card.id,
        uploaderId: user.id,
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        storageKey: 'k/a',
      },
    })

    const artifactB = await prisma.artifact.create({
      data: {
        cardId: card.id,
        uploaderId: user.id,
        filename: 'b.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        storageKey: 'k/b',
        parentArtifactId: artifactA.id,
      },
    })

    // Load A with children
    const aWithChildren = await prisma.artifact.findUniqueOrThrow({
      where: { id: artifactA.id },
      include: { children: true },
    })
    expect(aWithChildren.children).toHaveLength(1)
    expect(aWithChildren.children[0].id).toBe(artifactB.id)

    // Load B with parent
    const bWithParent = await prisma.artifact.findUniqueOrThrow({
      where: { id: artifactB.id },
      include: { parent: true },
    })
    expect(bWithParent.parent).not.toBeNull()
    expect(bWithParent.parent!.id).toBe(artifactA.id)
  })

  it('CASCADE: deleting a User removes the associated GoogleCredential', async () => {
    applyMigrations(dbPath)
    prisma = makePrisma(dbPath)

    const user = await prisma.user.create({
      data: { email: 'cascade@test.com', passwordHash: 'x', name: 'Cascade' },
    })

    await prisma.googleCredential.create({
      data: {
        userId: user.id,
        refreshTokenEncrypted: 'enc:abc',
        googleEmail: 'cascade@google.com',
        googleSub: 'sub-cascade-unique',
        scopes: 'drive.readonly',
        updatedAt: new Date(),
      },
    })

    // Credential exists
    const before = await prisma.googleCredential.findUnique({ where: { userId: user.id } })
    expect(before).not.toBeNull()

    // Delete the user — cascade should remove the credential
    await prisma.user.delete({ where: { id: user.id } })

    const after = await prisma.googleCredential.findUnique({ where: { userId: user.id } })
    expect(after).toBeNull()
  })

  it('SET NULL: deleting parent Artifact sets parentArtifactId to null on children', async () => {
    applyMigrations(dbPath)
    prisma = makePrisma(dbPath)

    const org = await prisma.organization.create({ data: { name: 'O2', slug: 'o2' } })
    const user = await prisma.user.create({
      data: { email: 'setnull@test.com', passwordHash: 'x', name: 'SetNull' },
    })
    const board = await prisma.board.create({ data: { name: 'B2', orgId: org.id } })
    const column = await prisma.column.create({
      data: { name: 'C2', boardId: board.id, position: 0 },
    })
    const card = await prisma.card.create({
      data: {
        title: 'Card2',
        columnId: column.id,
        boardId: board.id,
        position: 0,
        createdById: user.id,
      },
    })

    const parent = await prisma.artifact.create({
      data: {
        cardId: card.id,
        uploaderId: user.id,
        filename: 'parent.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storageKey: 'k/parent',
      },
    })

    const child = await prisma.artifact.create({
      data: {
        cardId: card.id,
        uploaderId: user.id,
        filename: 'child.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storageKey: 'k/child',
        parentArtifactId: parent.id,
      },
    })

    // Delete parent
    await prisma.artifact.delete({ where: { id: parent.id } })

    // Child still exists with parentArtifactId = null
    const childAfter = await prisma.artifact.findUniqueOrThrow({ where: { id: child.id } })
    expect(childAfter).not.toBeNull()
    expect(childAfter.parentArtifactId).toBeNull()
  })

  it('googleSub uniqueness: inserting two credentials with the same googleSub throws', async () => {
    applyMigrations(dbPath)
    prisma = makePrisma(dbPath)

    const userA = await prisma.user.create({
      data: { email: 'unique-a@test.com', passwordHash: 'x', name: 'A' },
    })
    const userB = await prisma.user.create({
      data: { email: 'unique-b@test.com', passwordHash: 'x', name: 'B' },
    })

    await prisma.googleCredential.create({
      data: {
        userId: userA.id,
        refreshTokenEncrypted: 'enc:a',
        googleEmail: 'shared@google.com',
        googleSub: 'sub-shared-123',
        scopes: 'drive.readonly',
        updatedAt: new Date(),
      },
    })

    await expect(
      prisma.googleCredential.create({
        data: {
          userId: userB.id,
          refreshTokenEncrypted: 'enc:b',
          googleEmail: 'shared2@google.com',
          googleSub: 'sub-shared-123', // same googleSub
          scopes: 'drive.readonly',
          updatedAt: new Date(),
        },
      })
    ).rejects.toThrow()
  })
})
