/**
 * 08: Assigned-to-me widget
 * - Seed assigned cards in beforeAll
 * - Verify the avatar badge shows a count > 0
 * - Verify AssignmentWidget renders sections on dashboard
 * - Click a card in the widget → verify navigation to board
 */
import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import path from 'path'
import { loginAsAdmin } from './fixtures/auth'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')
const prisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })

let boardId: string

test.beforeAll(async () => {
  const board = await prisma.board.findFirstOrThrow({ where: { name: 'Demo Board' } })
  boardId = board.id
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.com' } })
  const col = await prisma.column.findFirstOrThrow({ where: { boardId, name: 'Backlog' } })

  // Create 2 cards assigned to admin (not in "Done" column so they show in widget)
  for (let i = 0; i < 2; i++) {
    await prisma.card.upsert({
      where: { id: `e2e-assigned-me-${i}` },
      update: {},
      create: {
        id: `e2e-assigned-me-${i}`,
        title: `Assigned To Me Card ${i + 1}`,
        boardId,
        columnId: col.id,
        position: 200 + i,
        createdById: user.id,
        assigneeId: user.id,
      },
    })
  }

  await prisma.$disconnect()
})

test.describe('08 – assigned-to-me widget', () => {
  test('avatar badge shows assignment count, widget renders sections', async ({ page }) => {
    await loginAsAdmin(page)

    // Wait for the sidebar to show the avatar badge with a count > 0
    const avatarLink = page.getByRole('link', { name: /items need your attention/i })
    await expect(avatarLink).toBeVisible({ timeout: 15_000 })

    await page.goto('/dashboard')

    // AssignmentWidget sections should render
    await expect(page.getByText('Assigned to you')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Needs your action')).toBeVisible()

    // Our seeded card should appear
    await expect(page.getByText('Assigned To Me Card 1')).toBeVisible({ timeout: 10_000 })
  })

  test('clicking a card in the widget navigates to the board', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/dashboard')

    // Expand "Assigned to you" section if needed and click the card
    await expect(page.getByText('Assigned To Me Card 1')).toBeVisible({ timeout: 10_000 })
    await page.getByText('Assigned To Me Card 1').click()

    // Dashboard onCardClick navigates to the board
    await expect(page).toHaveURL(/\/board\//, { timeout: 10_000 })
  })
})
