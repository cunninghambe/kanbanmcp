import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')
// Next.js dev server forces NODE_ENV=development, so it loads .env files in
// development order: .env.development.local > .env.local > .env.development > .env
// Writing .env.local here ensures the e2e DATABASE_URL overrides the project .env.
// NOTE: Next.js skips .env.local in test mode, but since next dev forces
// NODE_ENV=development, .env.local IS loaded and takes priority over .env.
const ENV_TEST_PATH = path.resolve(__dirname, '../.env.local')

export default async function globalSetup() {
  // Point the Next.js webServer at the e2e DB even if .env has a different path.
  fs.writeFileSync(ENV_TEST_PATH, `DATABASE_URL=file:${E2E_DB}\n`)

  // Remove any stale e2e DB so the seed always starts fresh.
  execSync(`rm -f "${E2E_DB}" "${E2E_DB}-wal" "${E2E_DB}-shm"`, { stdio: 'inherit' })

  execSync('npx prisma db push --force-reset', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: `file:${E2E_DB}` },
    stdio: 'inherit',
  })

  execSync(
    `npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/seed.ts`,
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: `file:${E2E_DB}` },
      stdio: 'inherit',
    }
  )

  // Enable WAL mode so the Next.js server and Playwright test runner can both
  // read the SQLite database concurrently without "database is locked" errors.
  execSync(`sqlite3 "${E2E_DB}" "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;"`, {
    stdio: 'inherit',
  })
}
