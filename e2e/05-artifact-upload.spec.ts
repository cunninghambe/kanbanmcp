/**
 * 05: Artifact upload
 * - Upload a small text file → verify filename + size in ArtifactList
 * - Upload an .html file → verify inline 415 error
 * - Upload a 26 MB blob → verify inline 413 error
 * - Delete the uploaded artifact → verify it disappears
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
    where: { id: 'e2e-artifact-upload-card' },
    update: {},
    create: {
      id: 'e2e-artifact-upload-card',
      title: 'Artifact Upload Card',
      boardId,
      columnId: col.id,
      position: 100,
      createdById: user.id,
      assigneeId: user.id,
    },
  })

  await prisma.$disconnect()
})

test.describe('05 – artifact upload', () => {
  test('uploads a text file and verifies filename + size', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)
    await page.getByText('Artifact Upload Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const artifactsSection = page.getByRole('region', { name: /Artifacts/i })
    await expect(artifactsSection).toBeVisible()

    const fileInput = artifactsSection.locator('input[type="file"]')
    await fileInput.setInputFiles({
      name: 'test-artifact.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('This is test content for the artifact upload.', 'utf-8'),
    })
    await artifactsSection.getByRole('button', { name: /Upload artifact/i }).click()

    await expect(artifactsSection.getByText('test-artifact.txt')).toBeVisible({ timeout: 15_000 })
    await expect(artifactsSection.getByText(/\d+ B/)).toBeVisible()
  })

  test('rejects an HTML file with 415 error', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)
    await page.getByText('Artifact Upload Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const artifactsSection = page.getByRole('region', { name: /Artifacts/i })

    const fileInput = artifactsSection.locator('input[type="file"]')
    await fileInput.setInputFiles({
      name: 'malicious.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<html><body>hello</body></html>', 'utf-8'),
    })
    await artifactsSection.getByRole('button', { name: /Upload artifact/i }).click()

    await expect(
      artifactsSection.getByText(/File type not supported/i)
    ).toBeVisible({ timeout: 10_000 })
  })

  test('rejects a 26 MB file with 413 error', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)
    await page.getByText('Artifact Upload Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const artifactsSection = page.getByRole('region', { name: /Artifacts/i })

    const fileInput = artifactsSection.locator('input[type="file"]')
    await fileInput.setInputFiles({
      name: 'toobig.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(26 * 1024 * 1024, 'x'),
    })
    await artifactsSection.getByRole('button', { name: /Upload artifact/i }).click()

    await expect(
      artifactsSection.getByText(/File too large/i)
    ).toBeVisible({ timeout: 10_000 })
  })

  test('deletes the uploaded artifact', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto(`/board/${boardId}`)
    await page.getByText('Artifact Upload Card').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const artifactsSection = page.getByRole('region', { name: /Artifacts/i })
    const artifactItem = artifactsSection.getByText('test-artifact.txt')
    const count = await artifactItem.count()
    if (count === 0) {
      test.skip(true, 'test-artifact.txt not found; upload test may have failed')
      return
    }

    page.once('dialog', (dialog) => dialog.accept())
    await artifactsSection
      .getByRole('button', { name: /Delete test-artifact\.txt/i })
      .click()

    await expect(artifactsSection.getByText('test-artifact.txt')).not.toBeVisible({
      timeout: 10_000,
    })
  })
})
