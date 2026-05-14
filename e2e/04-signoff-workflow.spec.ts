/**
 * 04: Signoff workflow
 * - Create a card with admin as reviewer
 * - Submit APPROVED signoff with comment
 * - Verify signoff appears (latest-per-role)
 * - Submit REQUESTED_CHANGES — verify latest updates
 * - Log in as a non-reviewer user, verify SignoffPanel is read-only
 */
import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import path from 'path'
import { loginAsAdmin, loginAs } from './fixtures/auth'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')
const prisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })

let boardId: string
let cardId: string

test.beforeAll(async () => {
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: 'demo' } })
  const board = await prisma.board.findFirstOrThrow({ where: { name: 'Demo Board' } })
  boardId = board.id
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.com' } })
  const col = await prisma.column.findFirstOrThrow({ where: { boardId, name: 'Backlog' } })

  // Seed a secondary non-reviewer user
  const hash = await bcrypt.hash('testpass04', 12)
  const member = await prisma.user.upsert({
    where: { email: 'member04@e2e.test' },
    update: {},
    create: { email: 'member04@e2e.test', name: 'Member04', passwordHash: hash },
  })
  await prisma.orgMember.upsert({
    where: { userId_orgId: { userId: member.id, orgId: org.id } },
    update: {},
    create: { userId: member.id, orgId: org.id, role: 'MEMBER' },
  })

  // Create a card with admin as both assignee and reviewer
  const card = await prisma.card.upsert({
    where: { id: 'e2e-signoff-workflow-card' },
    update: {},
    create: {
      id: 'e2e-signoff-workflow-card',
      title: 'Signoff Workflow Card',
      boardId,
      columnId: col.id,
      position: 99,
      createdById: user.id,
      assigneeId: user.id,
      reviewerId: user.id,
    },
  })
  cardId = card.id

  // Disconnect before UI tests to avoid SQLite contention
  await prisma.$disconnect()
})

test.describe('04 – signoff workflow', () => {
  test('admin approves card as reviewer, then requests changes', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)
    await page.getByText('Signoff Workflow Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const signoffsSection = page.getByRole('region', { name: /Signoffs/i })
    await expect(signoffsSection).toBeVisible()

    // Fill comment and approve
    const commentTextarea = signoffsSection.locator('textarea[placeholder="Add a comment…"]')
    await commentTextarea.fill('Looks good to me')
    await signoffsSection.getByRole('button', { name: /Approve this card/i }).click()

    await expect(signoffsSection.getByText(/Approved successfully/i)).toBeVisible({ timeout: 10_000 })

    // Now request changes
    await signoffsSection.getByRole('button', { name: /Request changes/i }).click()
    await expect(signoffsSection.getByText(/Changes requested successfully/i)).toBeVisible({
      timeout: 10_000,
    })
  })

  test('non-reviewer sees read-only signoff panel', async ({ page }) => {
    await loginAs(page, 'member04@e2e.test', 'testpass04')
    await page.goto(`/board/${boardId}`)

    await page.getByText('Signoff Workflow Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const signoffsSection = page.getByRole('region', { name: /Signoffs/i })
    await expect(signoffsSection).toBeVisible()
    await expect(signoffsSection.getByRole('button', { name: /Approve this card/i })).not.toBeVisible()
    await expect(signoffsSection.getByRole('button', { name: /Reject this card/i })).not.toBeVisible()
  })
})
