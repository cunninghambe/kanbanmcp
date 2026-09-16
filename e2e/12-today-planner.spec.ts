/**
 * 12: Today planner
 * - Log in → land on /today (spec §5.7) with the sidebar link present
 * - Quick add a to-do → a row appears in the list
 * - Mark it done → it leaves the open sections and shows under "done today"
 * - Reopen brings it back
 * - The card source lists a card assigned to the user, and marking it done
 *   moves the card to the board's Done column (write-through, spec §4.10)
 */
import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import path from 'path'
import { loginAsAdmin } from './fixtures/auth'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')
const prisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })

const CARD_ID = 'e2e-planner-card-1'
const CARD_TITLE = 'Planner E2E assigned card'

test.beforeAll(async () => {
  const board = await prisma.board.findFirstOrThrow({ where: { name: 'Demo Board' } })
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.com' } })
  const col = await prisma.column.findFirstOrThrow({
    where: { boardId: board.id, name: 'Backlog' },
  })
  await prisma.card.upsert({
    where: { id: CARD_ID },
    update: { columnId: col.id, assigneeId: user.id },
    create: {
      id: CARD_ID,
      title: CARD_TITLE,
      boardId: board.id,
      columnId: col.id,
      position: 900,
      createdById: user.id,
      assigneeId: user.id,
    },
  })
  await prisma.plannerItem.deleteMany({ where: { userId: user.id } })
  await prisma.plannerDay.deleteMany({ where: { userId: user.id } })
})

test.afterAll(async () => {
  await prisma.card.deleteMany({ where: { id: CARD_ID } })
  await prisma.$disconnect()
})

test.describe('12 – today planner', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
  })

  test('login lands on /today with the sidebar link and the day title', async ({ page }) => {
    await expect(page).toHaveURL(/\/today/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^[a-z]{3} \d{1,2} [a-z]{3}$/)
    const link = page.getByRole('link', { name: 'today' })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', '/today')
    await expect(page.getByRole('button', { name: 'plan my day' })).toBeVisible()
  })

  test('quick add shows a row; done moves it to done today; reopen brings it back', async ({
    page,
  }) => {
    const title = `Planner E2E todo ${Date.now()}`
    const input = page.getByLabel('Quick add')
    await input.fill(title)
    await input.press('Enter')

    const row = page.getByRole('listitem', { name: title })
    await expect(row).toBeVisible()
    await expect(input).toHaveValue('')

    await row.getByRole('button', { name: 'Mark done' }).click()
    const doneRegion = page.getByRole('region', { name: 'done today' })
    await expect(doneRegion.getByRole('listitem', { name: title })).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'today' }).getByRole('listitem', { name: title })
    ).toHaveCount(0)

    await doneRegion
      .getByRole('listitem', { name: title })
      .getByRole('button', { name: 'Reopen' })
      .click()
    await expect(doneRegion.getByRole('listitem', { name: title })).toHaveCount(0)
    await expect(
      page.getByRole('listitem', { name: title }).getByRole('button', { name: 'Mark done' })
    ).toBeVisible()
  })

  test('an assigned card is collected; marking it done moves the card to Done', async ({
    page,
  }) => {
    const row = page.getByRole('listitem', { name: CARD_TITLE })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Mark done' }).click()
    await expect(
      page.getByRole('region', { name: 'done today' }).getByRole('listitem', { name: CARD_TITLE })
    ).toBeVisible()

    await expect
      .poll(async () => {
        const card = await prisma.card.findUniqueOrThrow({
          where: { id: CARD_ID },
          include: { column: true },
        })
        return card.column.name
      })
      .toBe('Done')
  })

  test('selecting a row opens the workspace with a composer', async ({ page }) => {
    const title = `Planner E2E compose ${Date.now()}`
    const input = page.getByLabel('Quick add')
    await input.fill(title)
    await input.press('Enter')
    const row = page.getByRole('listitem', { name: title })
    await row.getByText(title).click()
    await expect(row).toHaveAttribute('aria-selected', 'true')
    const workspace = page.getByRole('region', { name: 'workspace' })
    await expect(workspace.getByRole('heading', { name: title })).toBeVisible()
    await workspace.getByRole('button', { name: 'new draft' }).click()
    await expect(workspace.getByLabel('Draft body')).toBeVisible()
    await expect(workspace.getByLabel('Draft title')).toHaveValue(title)
  })
})
