/**
 * 06: AI Auto-Review (REAL CLAUDE CALL)
 * Skip if neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set.
 *
 * Uses direct API calls (page.request) to eliminate the toggle→params→upload
 * race that caused intermittent failures when going through the UI.
 *
 * Steps:
 * 1. PATCH the card to set aiAutoReview=true and aiReviewParams (awaited)
 * 2. POST a multipart artifact upload (awaited — triggers enqueueAiReview
 *    synchronously inside the route handler while aiAutoReview is guaranteed set)
 * 3. Poll DB until AiReview.status === 'done' (60s budget)
 * 4. Open the card modal in the browser and verify the AI Reviewer comment
 * 5. Confirm inputTokens > 0
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
    update: { aiAutoReview: false, aiReviewParams: null },
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
    if (!hasKey) return

    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)

    // Step 1: PATCH the card to enable aiAutoReview and set review params.
    // Awaiting the response guarantees the DB is updated before the upload.
    const patchRes = await page.request.patch(`/api/cards/${cardId}`, {
      data: {
        aiAutoReview: true,
        aiReviewParams: {
          model: 'claude-haiku-4-5-20251001',
          rubric:
            'Identify any spelling errors or grammar issues. Output as a markdown bullet list.',
        },
      },
    })
    expect(patchRes.status()).toBe(200)

    // Step 2: Upload the artifact via multipart POST.
    // The route handler reads card.aiAutoReview from the DB synchronously after
    // storing the file, so enqueueAiReview fires with the flag already set.
    const uploadRes = await page.request.post(`/api/cards/${cardId}/artifacts`, {
      multipart: {
        file: {
          name: 'spelling-errors.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            'This documnt has speling mistakes. Thier are serveral errers hear.',
            'utf-8'
          ),
        },
      },
    })
    expect(uploadRes.status()).toBe(201)

    // Step 3: Poll the DB until the AI review reaches "done" (fresh Prisma instance
    // avoids SQLite read-lock contention with the worker).
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

    // Step 4: Open the card modal in the browser and verify the AI Reviewer comment.
    await page.getByText('AI Auto-Review Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const commentsSection = page.getByRole('region', { name: /Comments/i })
    await expect(commentsSection).toBeVisible()
    await expect(commentsSection.getByText(/AI review of/i)).toBeVisible({ timeout: 15_000 })

    // Step 5: Confirm tokens were used (proves real Claude path was exercised).
    const finalPrisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })
    try {
      const review = await finalPrisma.aiReview.findFirst({ where: { cardId, status: 'done' } })
      expect(review).not.toBeNull()
      expect(review!.inputTokens).toBeGreaterThan(0)
      console.log(
        `[06] AI review completed. inputTokens=${review!.inputTokens} outputTokens=${review!.outputTokens}`
      )
    } finally {
      await finalPrisma.$disconnect()
    }
  })
})
