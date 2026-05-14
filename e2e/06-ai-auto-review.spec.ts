/**
 * 06: AI Auto-Review (REAL CLAUDE CALL)
 * Skip if neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set.
 *
 * - Open a card
 * - Toggle AiReviewToggle to ON, set rubric for spelling errors
 * - Upload a text file with deliberate spelling errors
 * - Wait up to 60 seconds for the AI review to reach "done" (polling DB)
 * - Reload the card modal and verify a comment appears from the AI Reviewer
 * - Confirm inputTokens > 0
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
    where: { id: 'e2e-ai-auto-review-card' },
    update: {},
    create: {
      id: 'e2e-ai-auto-review-card',
      title: 'AI Auto-Review Card',
      boardId,
      columnId: col.id,
      position: 101,
      createdById: user.id,
      assigneeId: user.id,
    },
  })
  cardId = card.id

  await prisma.$disconnect()
})

test.describe('06 – AI auto-review (real Claude)', () => {
  test('triggers a real AI review on artifact upload', async ({ page }) => {
    if (!hasKey) {
      test.skip(true, 'Skipping: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set')
      return
    }

    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)
    await page.getByText('AI Auto-Review Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // Enable AI Auto-Review
    const aiSection = page.getByRole('region', { name: /AI Auto-Review/i })
    await expect(aiSection).toBeVisible()

    const toggle = aiSection.getByRole('checkbox')
    if (!(await toggle.isChecked())) {
      await toggle.click()
    }

    // Fill in rubric
    const rubricTextarea = aiSection.locator('textarea').first()
    await rubricTextarea.fill('Identify any spelling errors or grammar issues. Output as a markdown bullet list.')

    await aiSection.getByRole('button', { name: /Save params/i }).click()
    await expect(aiSection.getByRole('button', { name: /Save params/i })).toBeEnabled({ timeout: 10_000 })

    // Upload a text file with deliberate spelling errors
    const artifactsSection = page.getByRole('region', { name: /Artifacts/i })
    const fileInput = artifactsSection.locator('input[type="file"]')
    await fileInput.setInputFiles({
      name: 'spelling-errors.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('This documnt has speling mistakes. Thier are serveral errers hear.', 'utf-8'),
    })
    await artifactsSection.getByRole('button', { name: /Upload artifact/i }).click()

    await expect(artifactsSection.getByText('spelling-errors.txt')).toBeVisible({ timeout: 15_000 })

    // Poll the DB until the AI review reaches "done" (uses a fresh Prisma instance)
    const reviewPrisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })
    try {
      await expect(async () => {
        const review = await reviewPrisma.aiReview.findFirst({
          where: { cardId, status: 'done' },
        })
        expect(review).not.toBeNull()
      }).toPass({ timeout: 60_000, intervals: [2000] })
    } finally {
      await reviewPrisma.$disconnect()
    }

    // Reload the card modal to pick up the freshly-posted comment
    await page.keyboard.press('Escape')
    await page.getByText('AI Auto-Review Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const commentsSection = page.getByRole('region', { name: /Comments/i })
    await expect(commentsSection).toBeVisible()
    await expect(commentsSection.getByText(/AI review of/i)).toBeVisible({ timeout: 15_000 })

    // Confirm tokens were used
    const finalPrisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })
    try {
      const review = await finalPrisma.aiReview.findFirst({ where: { cardId, status: 'done' } })
      expect(review).not.toBeNull()
      expect(review!.inputTokens).toBeGreaterThan(0)
      console.log(`[06] AI review completed. inputTokens=${review!.inputTokens} outputTokens=${review!.outputTokens}`)
    } finally {
      await finalPrisma.$disconnect()
    }
  })
})
