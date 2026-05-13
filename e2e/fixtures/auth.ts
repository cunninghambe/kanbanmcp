import { Page } from '@playwright/test'

/** Log in via the UI form and return the page (session cookie stored in browser context). */
export async function loginAsAdmin(page: Page) {
  await page.goto('/login')
  await page.fill('input[name="email"]', 'admin@demo.com')
  await page.fill('input[name="password"]', 'demo1234')
  await page.click('button[type="submit"]')
  await page.waitForURL('**/dashboard')
}
