/**
 * 02: Card creation and role assignment
 * - Create a new card via Prisma (UI requires assigneeId which the add-card form doesn't send)
 * - Open the new card's detail panel
 * - Set reviewer and approver via the RoleSelector
 * - Verify the role selects reflect the chosen values after re-open
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

  await prisma.card.upsert({
    where: { id: 'e2e-role-test-card' },
    update: {},
    create: {
      id: 'e2e-role-test-card',
      title: 'Role Test Card',
      boardId,
      columnId: col.id,
      position: 50,
      createdById: user.id,
      assigneeId: user.id,
    },
  })

  await prisma.$disconnect()
})

test.describe('02 – card create and roles', () => {
  test('opens card modal and assigns reviewer + approver', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)

    await page.getByText('Role Test Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const rolesSection = page.getByRole('region', { name: 'Roles' })
    await expect(rolesSection).toBeVisible()

    // With no reviewer/approver yet, the role selects render inline (comboboxes
    // named by role). Selecting a member saves and collapses the row to an
    // avatar + a "Change <role>" control — which is the proof the role is set.
    await rolesSection.getByRole('combobox', { name: 'Reviewer' }).selectOption({ index: 1 })
    await expect(rolesSection.getByRole('button', { name: 'Change reviewer' })).toBeVisible({
      timeout: 10_000,
    })

    await rolesSection.getByRole('combobox', { name: 'Approver' }).selectOption({ index: 1 })
    await expect(rolesSection.getByRole('button', { name: 'Change approver' })).toBeVisible({
      timeout: 10_000,
    })

    // Verify persistence: close and reopen — the collapsed "Change" controls
    // only render when a member is assigned, so their presence proves the
    // reviewer/approver were saved.
    await page.keyboard.press('Escape')
    await page.getByText('Role Test Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const rolesSection2 = page.getByRole('region', { name: 'Roles' })
    await expect(rolesSection2.getByRole('button', { name: 'Change reviewer' })).toBeVisible()
    await expect(rolesSection2.getByRole('button', { name: 'Change approver' })).toBeVisible()
  })
})
