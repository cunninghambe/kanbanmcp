import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the db module before importing the module under test
vi.mock('../../src/lib/db', () => ({ prisma: {} }))

import { resolveEffectiveAiReviewParams, envDefaultParams } from '../../src/lib/ai-review/inheritance'
import type { PrismaClient } from '@prisma/client'

// Build a mock prisma that returns a chain of cards.
function makeMockPrisma(
  cards: Record<string, { aiReviewParams: string | null; parentCardId: string | null }>
): Pick<PrismaClient, 'card'> {
  return {
    card: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        const c = cards[where.id]
        return Promise.resolve(c ?? null)
      }),
    } as unknown as PrismaClient['card'],
  } as Pick<PrismaClient, 'card'>
}

describe('resolveEffectiveAiReviewParams', () => {
  beforeEach(() => {
    delete process.env.AI_REVIEW_DEFAULT_RUBRIC
    delete process.env.AI_REVIEW_DEFAULT_MODEL
  })

  it('returns params from the card itself when set (AC-11 direct case)', async () => {
    const prisma = makeMockPrisma({
      'card-a': {
        aiReviewParams: JSON.stringify({ model: 'claude-sonnet-4-6', rubric: 'review code quality' }),
        parentCardId: null,
      },
    })
    const result = await resolveEffectiveAiReviewParams(prisma as unknown as PrismaClient, 'card-a')
    expect(result).toEqual({ model: 'claude-sonnet-4-6', rubric: 'review code quality' })
  })

  it('walks up to parent when card has null params (AC-11)', async () => {
    const prisma = makeMockPrisma({
      'card-child': { aiReviewParams: null, parentCardId: 'card-parent' },
      'card-parent': {
        aiReviewParams: JSON.stringify({ model: 'claude-sonnet-4-6', rubric: 'X' }),
        parentCardId: null,
      },
    })
    const result = await resolveEffectiveAiReviewParams(prisma as unknown as PrismaClient, 'card-child')
    expect(result?.rubric).toBe('X')
    expect(result?.model).toBe('claude-sonnet-4-6')
  })

  it('walks a 3-deep chain (E16: intermediate null)', async () => {
    const prisma = makeMockPrisma({
      'card-c': { aiReviewParams: null, parentCardId: 'card-b' },
      'card-b': { aiReviewParams: null, parentCardId: 'card-a' },
      'card-a': {
        aiReviewParams: JSON.stringify({ model: 'claude-opus-4-7', rubric: 'grandparent rubric' }),
        parentCardId: null,
      },
    })
    const result = await resolveEffectiveAiReviewParams(prisma as unknown as PrismaClient, 'card-c')
    expect(result?.rubric).toBe('grandparent rubric')
  })

  it('falls back to env defaults when all ancestors are null', async () => {
    process.env.AI_REVIEW_DEFAULT_RUBRIC = 'default rubric'
    process.env.AI_REVIEW_DEFAULT_MODEL = 'claude-haiku-3'
    const prisma = makeMockPrisma({
      'card-x': { aiReviewParams: null, parentCardId: null },
    })
    const result = await resolveEffectiveAiReviewParams(prisma as unknown as PrismaClient, 'card-x')
    expect(result?.rubric).toBe('default rubric')
    expect(result?.model).toBe('claude-haiku-3')
  })

  it('returns null when all ancestors null and env unset (E8)', async () => {
    const prisma = makeMockPrisma({
      'card-x': { aiReviewParams: null, parentCardId: null },
    })
    const result = await resolveEffectiveAiReviewParams(prisma as unknown as PrismaClient, 'card-x')
    expect(result).toBeNull()
  })

  it('terminates at MAX_NESTING_DEPTH even with a cycle (AC-12)', async () => {
    // Simulate a cycle: card-1 → card-2 → card-1 → ...
    const prisma = makeMockPrisma({
      'card-1': { aiReviewParams: null, parentCardId: 'card-2' },
      'card-2': { aiReviewParams: null, parentCardId: 'card-1' },
    })

    // Should not hang; should return null (no env fallback)
    const result = await resolveEffectiveAiReviewParams(prisma as unknown as PrismaClient, 'card-1')
    expect(result).toBeNull()

    // Verify it called findUnique exactly MAX_NESTING_DEPTH times (50)
    const { MAX_NESTING_DEPTH } = await import('../../src/lib/cards')
    expect((prisma.card.findUnique as ReturnType<typeof vi.fn>).mock.calls.length).toBe(MAX_NESTING_DEPTH)
  })
})

describe('envDefaultParams', () => {
  beforeEach(() => {
    delete process.env.AI_REVIEW_DEFAULT_RUBRIC
    delete process.env.AI_REVIEW_DEFAULT_MODEL
  })

  it('returns null when AI_REVIEW_DEFAULT_RUBRIC not set', () => {
    expect(envDefaultParams()).toBeNull()
  })

  it('returns params with default model when only rubric is set', () => {
    process.env.AI_REVIEW_DEFAULT_RUBRIC = 'my rubric'
    const p = envDefaultParams()
    expect(p?.rubric).toBe('my rubric')
    expect(p?.model).toBe('claude-opus-4-7')
  })

  it('uses AI_REVIEW_DEFAULT_MODEL when set', () => {
    process.env.AI_REVIEW_DEFAULT_RUBRIC = 'rubric'
    process.env.AI_REVIEW_DEFAULT_MODEL = 'claude-sonnet-4-6'
    expect(envDefaultParams()?.model).toBe('claude-sonnet-4-6')
  })
})
