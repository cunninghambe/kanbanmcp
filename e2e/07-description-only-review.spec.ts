/**
 * 07: Description-only AI review (REAL CLAUDE CALL)
 * Skip if neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set.
 *
 * Uses direct API calls (page.request) for deterministic setup. The card's
 * aiAutoReview flag and aiReviewParams are set via a PATCH before triggering
 * the review, so there is no UI race.
 *
 * Steps:
 * 1. beforeAll: upsert the card with description; delete stale reviews so the
 *    cooldown check (409) does not block re-runs
 * 2. PATCH the card to set aiReviewParams (awaited)
 * 3. POST /api/cards/[id]/reviews to trigger a description review (awaited)
 * 4. Poll DB until AiReview.status === 'done' (60s budget)
 * 5. Open the card modal in the browser and verify the AI Reviewer comment
 * 6. Confirm inputTokens > 0
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
    update: {
      description: 'This card describes the authentication setup process for the kanban app.',
      aiAutoReview: true,
      aiReviewParams: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        rubric: 'Briefly summarize this description in one sentence.',
      }),
    },
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

  // Delete any stale reviews from previous runs so the 409 cooldown check does
  // not block the POST /api/cards/[id]/reviews call below.
  await prisma.aiReview.deleteMany({ where: { cardId, artifactId: null } })

  await prisma.$disconnect()
})

test.describe('07 – description-only AI review (real Claude)', () => {
  test('triggers a real description review via the API', async ({ page }) => {
    if (!hasKey) return

    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)

    // Step 1: Ensure review params are set (PATCH is idempotent; guarantees
    // the DB reflects the intended state regardless of beforeAll ordering).
    const patchRes = await page.request.patch(`/api/cards/${cardId}`, {
      data: {
        aiReviewParams: {
          model: 'claude-haiku-4-5-20251001',
          rubric: 'Briefly summarize this description in one sentence.',
        },
      },
    })
    expect(patchRes.status()).toBe(200)

    // Step 2: Trigger the description review.
    const response = await page.request.post(`/api/cards/${cardId}/reviews`)
    expect(response.status()).toBe(201)

    // Step 3: Poll DB until review completes (fresh Prisma instance avoids
    // read-lock contention with the worker).
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

    // Step 4: Open the card modal and verify the AI Reviewer comment appears.
    await page.getByText('Description Review Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const commentsSection = page.getByRole('region', { name: /Comments/i })
    await expect(commentsSection).toBeVisible()
    await expect(commentsSection.getByText(/AI review of/i)).toBeVisible({ timeout: 15_000 })

    // Step 5: Confirm tokens were used (proves real Claude path was exercised).
    const finalPrisma = new PrismaClient({ datasources: { db: { url: `file:${E2E_DB}` } } })
    try {
      const review = await finalPrisma.aiReview.findFirst({
        where: { cardId, artifactId: null, status: 'done' },
      })
      expect(review).not.toBeNull()
      expect(review!.inputTokens).toBeGreaterThan(0)
      console.log(
        `[07] Description review completed. inputTokens=${review!.inputTokens} outputTokens=${review!.outputTokens}`
      )
    } finally {
      await finalPrisma.$disconnect()
    }
  })
})
