/**
 * 03: Sub-card tree
 * - Open a card's detail panel
 * - Use the SubCardTree section to add a sub-card
 * - Test "Promote to top-level" via the action menu
 */
import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import path from 'path'
import { loginAsAdmin } from './fixtures/auth'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')
const prisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })

let boardId: string
let parentCardTitle: string

test.beforeAll(async () => {
  const board = await prisma.board.findFirstOrThrow({ where: { name: 'Demo Board' } })
  boardId = board.id
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.com' } })
  const col = await prisma.column.findFirstOrThrow({ where: { boardId, name: 'Backlog' } })

  // Create a parent card WITH an assigneeId so sub-card creation works
  // (the AddSubcardForm passes root.assigneeId to the create API, which requires it)
  const parent = await prisma.card.upsert({
    where: { id: 'e2e-subcard-parent' },
    update: { assigneeId: user.id },
    create: {
      id: 'e2e-subcard-parent',
      title: 'SubCard Parent Card',
      boardId,
      columnId: col.id,
      position: 150,
      createdById: user.id,
      assigneeId: user.id,
    },
  })
  parentCardTitle = parent.title

  // Disconnect before UI tests to avoid SQLite contention
  await prisma.$disconnect()
})

test.describe('03 – subcard tree', () => {
  test('adds a sub-card and verifies tree renders', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)

    await page.getByText(parentCardTitle).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const subcardsSection = page.getByRole('region', { name: /Sub-cards/i })
    await expect(subcardsSection).toBeVisible({ timeout: 15_000 })

    // Add a sub-card
    await subcardsSection.getByRole('button', { name: /\+ Add sub-card/i }).click()
    const addForm = page.getByRole('form', { name: 'Add sub-card' })
    await addForm.getByLabel('Sub-card title').fill('Sub-card Level 1')
    await addForm.getByRole('button', { name: 'Add' }).click()

    await expect(subcardsSection.getByText('Sub-card Level 1')).toBeVisible({ timeout: 10_000 })
  })

  test('promotes a sub-card to top-level', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)

    await page.getByText(parentCardTitle).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const subcardsSection = page.getByRole('region', { name: /Sub-cards/i })
    const subCardText = subcardsSection.getByText('Sub-card Level 1')
    const count = await subCardText.count()
    if (count === 0) {
      test.skip(true, 'Sub-card from previous test not found; run tests in order')
      return
    }

    // Hover to reveal action menu
    await subCardText.first().hover()
    await page.getByRole('button', { name: /Actions for Sub-card Level 1/i }).click()
    await page.getByRole('menuitem', { name: /Promote to top-level/i }).click()

    // Confirm dialog
    await expect(page.getByRole('dialog', { name: /Promote to top-level/i })).toBeVisible()
    await page.getByRole('button', { name: 'Promote' }).click()

    // Wider budget than the config default: this is the first call to the
    // promote API route in the run, and Next dev (Turbopack) compiling it
    // on-demand can outlast a routine assertion wait. See playwright.config.ts.
    await expect(subcardsSection.getByText('Sub-card Level 1')).not.toBeVisible({ timeout: 30_000 })
  })
})
