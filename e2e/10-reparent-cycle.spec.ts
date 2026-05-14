/**
 * 10: Reparent cycle detection
 * - Create a parent card and a child card
 * - Try to reparent the parent UNDER the child → expect 400 "Cycle detected"
 */
import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import path from 'path'
import { loginAsAdmin } from './fixtures/auth'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')
const prisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })

let boardId: string
let parentCardId: string
let childCardId: string

test.beforeAll(async () => {
  const board = await prisma.board.findFirstOrThrow({ where: { name: 'Demo Board' } })
  boardId = board.id
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.com' } })
  const col = await prisma.column.findFirstOrThrow({ where: { boardId, name: 'Backlog' } })

  const parent = await prisma.card.upsert({
    where: { id: 'e2e-cycle-parent' },
    update: {},
    create: {
      id: 'e2e-cycle-parent',
      title: 'Cycle Parent Card',
      boardId,
      columnId: col.id,
      position: 300,
      createdById: user.id,
      assigneeId: user.id,
      path: '',
      depth: 0,
    },
  })
  parentCardId = parent.id

  const child = await prisma.card.upsert({
    where: { id: 'e2e-cycle-child' },
    update: {},
    create: {
      id: 'e2e-cycle-child',
      title: 'Cycle Child Card',
      boardId,
      columnId: col.id,
      position: 301,
      createdById: user.id,
      assigneeId: user.id,
      parentCardId: parent.id,
      path: `/${parent.id}/`,
      depth: 1,
    },
  })
  childCardId = child.id

  await prisma.$disconnect()
})

test.describe('10 – reparent cycle detection', () => {
  test('returns 400 Cycle detected when reparenting parent under its own child', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)

    const res = await page.request.post(`/api/cards/${parentCardId}/reparent`, {
      data: { parentCardId: childCardId },
      headers: { 'Content-Type': 'application/json' },
    })

    expect(res.status()).toBe(400)
    const body = await res.json()
    expect((body as { error: string }).error).toMatch(/Cycle detected/i)
  })
})
