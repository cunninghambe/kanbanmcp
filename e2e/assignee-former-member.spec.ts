/**
 * E5: "assignee removed from org shows (former member)"
 *
 * Scenario:
 *  - User A (admin@demo.com) is the assignee of a card.
 *  - User A is removed from the OrgMember table (simulating an org departure).
 *  - User B (b@e2e.test) opens the board and the card detail panel.
 *  - The Assignee field must display "(former member)" instead of a blank / broken select.
 */

import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import path from 'path'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')
const prisma = new PrismaClient({
  datasources: { db: { url: `file:${E2E_DB}` } },
})

let boardId: string
let orgId: string
let userAId: string

test.beforeAll(async () => {
  // Retrieve the org and user A seeded by globalSetup
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: 'demo' } })
  orgId = org.id

  const userA = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.com' } })
  userAId = userA.id

  // Ensure user B exists with a known password
  const passwordHash = await bcrypt.hash('testpass99', 12)
  const userB = await prisma.user.upsert({
    where: { email: 'b@e2e.test' },
    update: {},
    create: { email: 'b@e2e.test', name: 'User B', passwordHash },
  })
  await prisma.orgMember.upsert({
    where: { userId_orgId: { userId: userB.id, orgId } },
    update: {},
    create: { userId: userB.id, orgId, role: 'MEMBER' },
  })

  // Create a board + column + card assigned to user A
  const board = await prisma.board.create({ data: { name: 'E5 Board', orgId } })
  boardId = board.id
  const column = await prisma.column.create({
    data: { name: 'To Do', boardId, position: 0 },
  })
  await prisma.card.create({
    data: {
      title: 'Former-member card',
      boardId,
      columnId: column.id,
      position: 0,
      createdById: userAId,
      assigneeId: userAId,
    },
  })

  // Remove user A from the org — simulates "removed from org"
  await prisma.orgMember.delete({
    where: { userId_orgId: { userId: userAId, orgId } },
  })
})

test.afterAll(async () => {
  // Restore user A's membership so the seed stays valid for future runs
  await prisma.orgMember.upsert({
    where: { userId_orgId: { userId: userAId, orgId } },
    update: {},
    create: { userId: userAId, orgId, role: 'ADMIN' },
  })
  await prisma.$disconnect()
})

test('assignee removed from org shows (former member) in card detail', async ({ page }) => {
  // Log in as user B
  await page.goto('/login')
  await page.fill('input[name="email"]', 'b@e2e.test')
  await page.fill('input[name="password"]', 'testpass99')
  await page.click('button[type="submit"]')
  await page.waitForURL('**/dashboard')

  // Navigate to the board
  await page.goto(`/board/${boardId}`)

  // Click the card to open the detail panel
  await page.getByText('Former-member card').click()

  // Target the Assignee select within the "Roles" section (CardDetailSections).
  // There are two Assignee selects on the page — one in the Roles section (main
  // content) and one in the sidebar. Both should reflect "(former member)", but
  // we assert on the Roles section one because it has a clear accessible label.
  const rolesSection = page.getByRole('region', { name: 'Roles' })
  await expect(rolesSection).toBeVisible()

  const assigneeSelect = rolesSection.getByLabel('Assignee')
  await expect(assigneeSelect).toBeVisible()

  // The select must have a "(former member)" option rendered by RoleSelector.
  const formerMemberOption = assigneeSelect.locator('option', { hasText: '(former member)' })
  await expect(formerMemberOption).toHaveCount(1)

  // The select's current value should be the former member's user ID (not empty).
  await expect(assigneeSelect).toHaveValue(userAId)
})
