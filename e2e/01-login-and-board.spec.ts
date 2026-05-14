/**
 * 01: Login and board rendering
 * - Log in as admin@demo.com
 * - Land on dashboard
 * - Click into the seeded Demo Board
 * - Verify all 4 columns render (Backlog, In Progress, Review, Done)
 * - Verify 6 sample cards render
 */
import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './fixtures/auth'

test.describe('01 – login and board', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
  })

  test('lands on dashboard after login', async ({ page }) => {
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('Demo Board shows 4 columns and 6 cards', async ({ page }) => {
    // Click the Demo Board from the sidebar or dashboard
    await page.getByText('Demo Board').first().click()
    await page.waitForURL(/\/board\//)

    // Verify all 4 column headings
    for (const name of ['Backlog', 'In Progress', 'Review', 'Done']) {
      await expect(page.getByRole('heading', { name, level: 3 })).toBeVisible()
    }

    // Verify 6 sample cards exist by title
    for (const title of [
      'Set up authentication',
      'Design database schema',
      'Implement REST API endpoints',
      'Build kanban board UI',
      'Add drag-and-drop support',
      'Deploy to production',
    ]) {
      await expect(page.getByText(title).first()).toBeVisible()
    }
  })
})
