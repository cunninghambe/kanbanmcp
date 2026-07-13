/**
 * 08: "Your queue" dashboard
 * - Seed assigned cards in beforeAll
 * - Verify the redesigned dashboard renders the "your queue" view with the
 *   user's assigned cards as keyboard-accessible queue rows
 * - Click a queue row → verify navigation to the board
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

test.describe('08 – your-queue dashboard', () => {
  test('dashboard renders the "your queue" view with the user\'s assigned cards', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/dashboard')

    // Redesigned dashboard: a "your queue" view replaces the old AssignmentWidget
    // "Assigned to you" / "Needs your action" sections.
    await expect(page.getByRole('heading', { name: /your queue/i, level: 1 })).toBeVisible({
      timeout: 15_000,
    })

    // Seeded assigned cards appear as queue rows.
    await expect(page.getByText('Assigned To Me Card 1').first()).toBeVisible({ timeout: 10_000 })
  })

  test('clicking a queue row navigates to the card\'s real board and opens it', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/dashboard')

    // Queue rows are keyboard-accessible <button role="listitem"> elements whose
    // click handler routes to /board/<boardId>?card=<cardId> — the card's real
    // board, deep-linked to open the card. (A card id is not a board id: routing
    // to /board/<cardId> 404s and previously crashed the board page.)
    const row = page.getByText('Assigned To Me Card 1').first()
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.click()

    await expect(page).toHaveURL(new RegExp(`/board/${boardId}\\?card=`), { timeout: 10_000 })

    // The board actually rendered (not the "board not found" fallback a
    // malformed board response would hit) and the deep-linked card opened.
    await expect(page.getByRole('heading', { name: 'Demo Board', level: 1 })).toBeVisible({
      timeout: 10_000,
    })
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await expect(modal.locator('#card-title')).toHaveValue('Assigned To Me Card 1')
  })
})
