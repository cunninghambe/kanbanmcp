import { Page } from '@playwright/test'

/**
 * Log in via the UI form and wait until the sidebar confirms the session is
 * active (email visible). This guarantees that a subsequent `page.goto`
 * within the same browser context will find an authenticated session.
 */
export async function loginAsAdmin(page: Page) {
  await page.goto('/login')
  await page.fill('input[name="email"]', 'admin@demo.com')
  await page.fill('input[name="password"]', 'demo1234')
  await page.click('button[type="submit"]')
  await page.waitForURL('**/dashboard')
  // Confirm the sidebar has rendered with the user's email — this proves
  // /api/auth/me returned successfully and the session cookie is valid.
  await page.waitForSelector('text=admin@demo.com', { timeout: 10_000 })
}

/** Log in as an arbitrary user. */
export async function loginAs(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
  await page.click('button[type="submit"]')
  await page.waitForURL('**/dashboard')
}
