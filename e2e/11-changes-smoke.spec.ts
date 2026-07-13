/**
 * 11: Changes surface smoke test
 * - Click the sidebar "changes" nav link
 * - Verify navigation to /changes
 * - Verify the pending list renders (defaults to the "pending" filter, empty
 *   in the seeded demo org)
 */
import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './fixtures/auth'

test.describe('11 – changes smoke', () => {
  test('sidebar navigates to /changes and renders the pending list', async ({ page }) => {
    await loginAsAdmin(page)

    await page.getByRole('link', { name: 'changes' }).click()
    await page.waitForURL('**/changes')

    await expect(page.getByRole('heading', { name: 'Changes', level: 1 })).toBeVisible()

    const filterGroup = page.getByRole('group', { name: 'Filter changes by status' })
    await expect(filterGroup).toBeVisible()
    await expect(filterGroup.getByRole('button', { name: 'pending', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // Seeded demo org has no change sets under the default "pending" filter.
    await expect(page.getByText('no change sets')).toBeVisible({ timeout: 10_000 })
  })
})
