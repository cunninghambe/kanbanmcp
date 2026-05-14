/**
 * 07: Description-only AI review (REAL CLAUDE CALL)
 * Skip if neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set.
 *
 * - Create a card with a description and AI review params configured
 * - Trigger description review via POST /api/cards/[id]/reviews
 * - Poll DB until the review reaches "done"
 * - Open the card modal and verify a comment appears from the AI Reviewer
 */
import './fixtures/load-anthropic-env'
import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import path from 'path'
import { loginAsAdmin } from './fixtures/auth'

const E2E_DB = path.resolve(__dirname, '../playwright-e2e.db')
const prisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })

const hasKey =
  !!(process.env.ANTHROPIC_API_KEY?.trim()) || !!(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim())

let boardId: string
let cardId: string

test.beforeAll(async () => {
  if (!hasKey) {
    await prisma.$disconnect()
    return
  }
  const board = await prisma.board.findFirstOrThrow({ where: { name: 'Demo Board' } })
  boardId = board.id
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.com' } })
  const col = await prisma.column.findFirstOrThrow({ where: { boardId, name: 'Backlog' } })

  const card = await prisma.card.upsert({
    where: { id: 'e2e-desc-review-card' },
    update: {},
    create: {
      id: 'e2e-desc-review-card',
      title: 'Description Review Card',
      description: 'This card describes the authentication setup process for the kanban app.',
      boardId,
      columnId: col.id,
      position: 102,
      createdById: user.id,
      assigneeId: user.id,
      aiAutoReview: true,
      aiReviewParams: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        rubric: 'Briefly summarize this description in one sentence.',
      }),
    },
  })
  cardId = card.id

  await prisma.$disconnect()
})

test.describe('07 – description-only AI review (real Claude)', () => {
  test('triggers a real description review via the API', async ({ page }) => {
    if (!hasKey) {
      test.skip(true, 'Skipping: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set')
      return
    }

    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)

    // Trigger description review via the authenticated browser context
    const response = await page.request.post(`/api/cards/${cardId}/reviews`)
    expect(response.status()).toBe(201)

    // Poll DB until review completes (fresh Prisma instance to avoid locking)
    const pollPrisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })
    try {
      await expect(async () => {
        const review = await pollPrisma.aiReview.findFirst({
          where: { cardId, artifactId: null },
        })
        expect(review?.status).toBe('done')
      }).toPass({ timeout: 60_000, intervals: [2000] })
    } finally {
      await pollPrisma.$disconnect()
    }

    // Open the card and verify the AI reviewer comment
    await page.getByText('Description Review Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const commentsSection = page.getByRole('region', { name: /Comments/i })
    await expect(commentsSection).toBeVisible()
    await expect(commentsSection.getByText(/AI review of/i)).toBeVisible({ timeout: 15_000 })

    // Confirm tokens were used
    const finalPrisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })
    try {
      const review = await finalPrisma.aiReview.findFirst({
        where: { cardId, artifactId: null, status: 'done' },
      })
      expect(review).not.toBeNull()
      expect(review!.inputTokens).toBeGreaterThan(0)
      console.log(`[07] Description review completed. inputTokens=${review!.inputTokens} outputTokens=${review!.outputTokens}`)
    } finally {
      await finalPrisma.$disconnect()
    }
  })
})
