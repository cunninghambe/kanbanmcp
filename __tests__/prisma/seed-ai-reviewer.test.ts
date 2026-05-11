import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ensureAiReviewerUser,
  AI_REVIEWER_EMAIL,
  AI_REVIEWER_NAME,
} from '../../prisma/seed-ai-reviewer'
import type { PrismaClient } from '@prisma/client'

const FIXED_USER = {
  id: 'cltest000000000000000000000',
  email: AI_REVIEWER_EMAIL,
  name: AI_REVIEWER_NAME,
  passwordHash: '$2a$12$fakehash',
  isAgent: true,
  createdAt: new Date(),
}

function makeMockPrisma() {
  return {
    user: {
      upsert: vi.fn().mockResolvedValue(FIXED_USER),
    },
  } as unknown as PrismaClient
}

describe('ensureAiReviewerUser', () => {
  let prisma: PrismaClient

  beforeEach(() => {
    prisma = makeMockPrisma()
  })

  it('calls upsert with the correct where clause', async () => {
    await ensureAiReviewerUser(prisma)
    expect(prisma.user.upsert).toHaveBeenCalledOnce()
    const call = vi.mocked(prisma.user.upsert).mock.calls[0][0]
    expect(call.where).toEqual({ email: AI_REVIEWER_EMAIL })
  })

  it('passes empty update object', async () => {
    await ensureAiReviewerUser(prisma)
    const call = vi.mocked(prisma.user.upsert).mock.calls[0][0]
    expect(call.update).toEqual({})
  })

  it('creates with isAgent true and correct name', async () => {
    await ensureAiReviewerUser(prisma)
    const call = vi.mocked(prisma.user.upsert).mock.calls[0][0]
    expect(call.create.isAgent).toBe(true)
    expect(call.create.name).toBe(AI_REVIEWER_NAME)
    expect(call.create.email).toBe(AI_REVIEWER_EMAIL)
  })

  it('create payload has a non-empty passwordHash', async () => {
    await ensureAiReviewerUser(prisma)
    const call = vi.mocked(prisma.user.upsert).mock.calls[0][0]
    expect(typeof call.create.passwordHash).toBe('string')
    expect(call.create.passwordHash.length).toBeGreaterThan(0)
  })

  it('returns id, email, and name', async () => {
    const result = await ensureAiReviewerUser(prisma)
    expect(result).toEqual({
      id: FIXED_USER.id,
      email: FIXED_USER.email,
      name: FIXED_USER.name,
    })
  })
})
