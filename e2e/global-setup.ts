import { execSync } from 'child_process'
import path from 'path'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')

export default async function globalSetup() {
  // Remove any stale e2e DB so the seed always starts fresh.
  execSync(`rm -f "${E2E_DB}"`, { stdio: 'inherit' })

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
}
