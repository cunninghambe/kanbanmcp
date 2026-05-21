/**
 * M2 Migration Tests — AC9
 *
 * Validates that the migration at
 *   prisma/migrations/20260520120000_m2_card_executions/migration.sql
 * produces the correct schema and data transformations.
 *
 * These tests run against a fresh SQLite file per test (never the live DB).
 * They FAIL today because migration.sql does not yet exist — that is correct
 * TDD behaviour. They pass after Task 1 (the migration) lands.
 *
 * Assertions:
 *   T1  Board with the 4 default columns gets a Blocked column at position 4.
 *   T2  Board that already has a "Blocked" column (any case) is not touched.
 *   T3  card_executions table exists with the expected columns after migration.
 *   T4  Spoonworks-fixture board ends up with columns in exact order 0-4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── Path to the migration file under test ───────────────────────────────────

const MIGRATION_SQL_PATH = join(
  __dirname,
  '../../prisma/migrations/20260520120000_m2_card_executions/migration.sql'
)

// ─── Minimal baseline schema (boards + columns only) ─────────────────────────
// We only need the tables the migration touches. The full app schema is not
// required for these structural / data-transformation tests.

const BASELINE_SCHEMA_SQL = `
CREATE TABLE "organizations" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "slug"      TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "boards" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "boards_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "columns" (
  "id"       TEXT NOT NULL PRIMARY KEY,
  "name"     TEXT NOT NULL,
  "boardId"  TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "columns_boardId_fkey"
    FOREIGN KEY ("boardId") REFERENCES "boards" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "users" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "email"        TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "isAgent"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "cards" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "title"       TEXT NOT NULL,
  "description" TEXT,
  "columnId"    TEXT NOT NULL,
  "boardId"     TEXT NOT NULL,
  "assigneeId"  TEXT,
  "priority"    TEXT NOT NULL DEFAULT 'none',
  "position"    INTEGER NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   DATETIME NOT NULL,
  "path"        TEXT NOT NULL DEFAULT '',
  "depth"       INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "cards_columnId_fkey"
    FOREIGN KEY ("columnId") REFERENCES "columns" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cards_boardId_fkey"
    FOREIGN KEY ("boardId") REFERENCES "boards" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`.trim()

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

function runSql(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-separator', '\t', dbPath, sql], {
    encoding: 'utf8',
  })
}

function queryRows(dbPath: string, sql: string): Row[] {
  // Use .mode json for structured output
  const raw = execFileSync(
    'sqlite3',
    ['-json', dbPath, sql],
    { encoding: 'utf8' }
  ).trim()
  if (!raw) return []
  return JSON.parse(raw) as Row[]
}

function applyMigration(dbPath: string): void {
  const migrationSql = readFileSync(MIGRATION_SQL_PATH, 'utf8')
  // Execute migration in the same sqlite3 process, respecting PRAGMA statements
  execFileSync('sqlite3', [dbPath], {
    input: migrationSql,
    encoding: 'utf8',
  })
}

function seedBoard(
  dbPath: string,
  boardId: string,
  boardName: string,
  columns: Array<{ id: string; name: string; position: number }>
): void {
  const orgSql = `INSERT OR IGNORE INTO "organizations" ("id","name","slug") VALUES ('org-1','Test Org','test-org');`
  const boardSql = `INSERT INTO "boards" ("id","name","orgId") VALUES ('${boardId}','${boardName}','org-1');`
  const colSqls = columns
    .map(
      (c) =>
        `INSERT INTO "columns" ("id","name","boardId","position") VALUES ('${c.id}','${c.name}','${boardId}',${c.position});`
    )
    .join('\n')
  runSql(dbPath, `${orgSql}\n${boardSql}\n${colSqls}`)
}

// ─── Per-test DB lifecycle ────────────────────────────────────────────────────

let tmpDir: string
let dbPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'test-m2-'))
  dbPath = join(tmpDir, 'test.db')
  // Bootstrap with the minimal schema
  execFileSync('sqlite3', [dbPath], {
    input: BASELINE_SCHEMA_SQL,
    encoding: 'utf8',
  })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── T1: Board with 4 default columns gets Blocked at position 4 ─────────────

describe('AC9 migration', () => {
  it('adds a Blocked column at position 4 to a board with the 4 default columns', () => {
    // Given: a board with Backlog(0), In Progress(1), Review(2), Done(3)
    seedBoard(dbPath, 'board-1', 'My Board', [
      { id: 'col-backlog', name: 'Backlog', position: 0 },
      { id: 'col-inprogress', name: 'In Progress', position: 1 },
      { id: 'col-review', name: 'Review', position: 2 },
      { id: 'col-done', name: 'Done', position: 3 },
    ])

    // When: migration runs
    applyMigration(dbPath)

    // Then: board-1 has exactly 5 columns, and the new one is Blocked at position 4
    const cols = queryRows(
      dbPath,
      `SELECT name, position FROM "columns" WHERE boardId='board-1' ORDER BY position`
    )
    expect(cols).toHaveLength(5)
    const blocked = cols.find((c) => c.name === 'Blocked')
    expect(blocked).toBeDefined()
    expect(Number(blocked!.position)).toBe(4)
  })

  // ─── T2: Board already having a Blocked-named column is not modified ─────────

  it('does not insert a duplicate Blocked column when board already has one (case-insensitive)', () => {
    // Given: a board that already has a column named "blocked" (lower-case)
    seedBoard(dbPath, 'board-already-blocked', 'My Board', [
      { id: 'col-b1', name: 'Backlog', position: 0 },
      { id: 'col-b2', name: 'In Progress', position: 1 },
      { id: 'col-b3', name: 'Review', position: 2 },
      { id: 'col-b4', name: 'Done', position: 3 },
      { id: 'col-b5', name: 'blocked', position: 4 },  // already present, lowercase
    ])

    // When: migration runs
    applyMigration(dbPath)

    // Then: still exactly 5 columns — no duplicate inserted
    const cols = queryRows(
      dbPath,
      `SELECT name FROM "columns" WHERE boardId='board-already-blocked'`
    )
    expect(cols).toHaveLength(5)

    // And the BLOCKED-matching column count is exactly 1
    const blockedCount = cols.filter(
      (c) => (c.name as string).toLowerCase() === 'blocked'
    ).length
    expect(blockedCount).toBe(1)
  })

  it('does not insert a duplicate when the existing column is spelled "BLOCKED" (upper-case)', () => {
    // Given: board with upper-case BLOCKED
    seedBoard(dbPath, 'board-upper-blocked', 'Upper Board', [
      { id: 'cu1', name: 'Backlog', position: 0 },
      { id: 'cu2', name: 'In Progress', position: 1 },
      { id: 'cu3', name: 'Review', position: 2 },
      { id: 'cu4', name: 'Done', position: 3 },
      { id: 'cu5', name: 'BLOCKED', position: 4 },
    ])

    // When: migration runs
    applyMigration(dbPath)

    // Then: still exactly 5 columns
    const cols = queryRows(
      dbPath,
      `SELECT name FROM "columns" WHERE boardId='board-upper-blocked'`
    )
    expect(cols).toHaveLength(5)
    const blockedCount = cols.filter(
      (c) => (c.name as string).toLowerCase() === 'blocked'
    ).length
    expect(blockedCount).toBe(1)
  })

  // ─── T3: card_executions table exists with expected columns ──────────────────

  it('creates the card_executions table with all required columns after migration', () => {
    // Given: baseline schema (no card_executions table)
    // When: migration runs
    applyMigration(dbPath)

    // Then: table exists and PRAGMA table_info returns the expected column names
    const info = queryRows(dbPath, `PRAGMA table_info("card_executions")`)
    expect(info.length).toBeGreaterThan(0)

    const columnNames = info.map((row) => row.name)

    const required = [
      'id',
      'cardId',
      'jobId',
      'state',
      'project',
      'branch',
      'spec',
      'output',
      'errorMessage',
      'enqueuedAt',
      'startedAt',
      'finishedAt',
    ]

    for (const col of required) {
      expect(columnNames, `expected column "${col}" in card_executions`).toContain(col)
    }
  })

  // ─── T4: Spoonworks fixture ends up in exact column order 0–4 ────────────────

  it('Spoonworks-fixture board ends up with columns in exact order: Backlog(0) In Progress(1) Review(2) Done(3) Blocked(4)', () => {
    // Given: a board mimicking the live Spoonworks board — 4 default columns
    seedBoard(dbPath, 'board-spoonworks', 'Spoonworks', [
      { id: 'sw-col-0', name: 'Backlog', position: 0 },
      { id: 'sw-col-1', name: 'In Progress', position: 1 },
      { id: 'sw-col-2', name: 'Review', position: 2 },
      { id: 'sw-col-3', name: 'Done', position: 3 },
    ])

    // When: migration runs
    applyMigration(dbPath)

    // Then: columns are in exact order with exact names and positions
    const cols = queryRows(
      dbPath,
      `SELECT name, position FROM "columns" WHERE boardId='board-spoonworks' ORDER BY position`
    )

    expect(cols).toHaveLength(5)
    expect(cols[0]).toMatchObject({ name: 'Backlog', position: 0 })
    expect(cols[1]).toMatchObject({ name: 'In Progress', position: 1 })
    expect(cols[2]).toMatchObject({ name: 'Review', position: 2 })
    expect(cols[3]).toMatchObject({ name: 'Done', position: 3 })
    expect(cols[4]).toMatchObject({ name: 'Blocked', position: 4 })
  })

  // ─── Bonus: existing card positions on existing columns are unchanged ─────────

  it('existing column positions on existing columns are unchanged after migration', () => {
    // Given: a board with 4 columns, each having a non-default position offset
    seedBoard(dbPath, 'board-positions', 'Position Board', [
      { id: 'p-col-0', name: 'Backlog', position: 0 },
      { id: 'p-col-1', name: 'In Progress', position: 1 },
      { id: 'p-col-2', name: 'Review', position: 2 },
      { id: 'p-col-3', name: 'Done', position: 3 },
    ])

    // When: migration runs
    applyMigration(dbPath)

    // Then: the original four columns have unchanged positions
    const originalCols = queryRows(
      dbPath,
      `SELECT name, position FROM "columns" WHERE boardId='board-positions' AND name != 'Blocked' ORDER BY position`
    )
    expect(originalCols).toHaveLength(4)
    expect(Number(originalCols[0].position)).toBe(0)
    expect(Number(originalCols[1].position)).toBe(1)
    expect(Number(originalCols[2].position)).toBe(2)
    expect(Number(originalCols[3].position)).toBe(3)
  })
})
