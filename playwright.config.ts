import { defineConfig } from '@playwright/test'
import path from 'path'

const E2E_DB = path.resolve(__dirname, 'playwright-e2e.db')
const SESSION_SECRET = 'd597d4a359550cb02ffcf391f220b6f8f492ca205f5b2ecfcb011d203bc3fb74'
const E2E_PORT = 3099

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
    command: `npx next dev -p ${E2E_PORT}`,
    port: E2E_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: `file:${E2E_DB}`,
      SESSION_SECRET,
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
      PORT: String(E2E_PORT),
    },
  },
})
