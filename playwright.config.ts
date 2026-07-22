import { defineConfig } from '@playwright/test'
import path from 'path'
import './e2e/fixtures/load-anthropic-env'

const E2E_DB = path.resolve(__dirname, 'playwright-e2e.db')
const SESSION_SECRET = 'playwright-test-secret-not-a-real-secret-min-32-chars-padding-xx'
const E2E_PORT = 3099

export default defineConfig({
  testDir: './e2e',
  // Next.js dev server (Turbopack) compiles each route on first request. The
  // post-HUD-merge app is large enough that a cold first hit on a
  // not-yet-compiled route/API handler can take tens of seconds — these
  // budgets give that headroom without masking genuine hangs. See
  // e2e/03-subcard-tree.spec.ts for the concrete flaky case this covers.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    headless: true,
    trace: 'on-first-retry',
  },

  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  webServer: {
    // DATABASE_URL is set as a shell prefix so it takes effect before Next.js
    // loads any .env files — Turbopack in Next.js 16 only shows "Environments: .env"
    // and the webServer env object alone is not enough to override .env values.
    command: `DATABASE_URL=file:${E2E_DB} PLAYWRIGHT_E2E=1 npx next dev -p ${E2E_PORT}`,
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: `file:${E2E_DB}`,
      SESSION_SECRET,
      COOKIE_SECURE: 'false',
      PORT: String(E2E_PORT),
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
      AI_REVIEW_DEFAULT_MODEL: process.env.AI_REVIEW_DEFAULT_MODEL ?? 'claude-haiku-4-5-20251001',
      AI_REVIEW_DEFAULT_RUBRIC: 'You are a strict code/document reviewer. Give a 3-bullet critique.',
      PLAYWRIGHT_E2E: '1',
    },
  },
})
