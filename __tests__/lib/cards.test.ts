import { describe, it, expect, vi } from 'vitest'
import {
  computeChildPathAndDepth,
  aiReviewParamsSchema,
  roleMembershipCheck,
  decodeAiReviewParams,
  MAX_NESTING_DEPTH,
} from '../../src/lib/cards'

describe('MAX_NESTING_DEPTH', () => {
  it('is 50', () => {
    expect(MAX_NESTING_DEPTH).toBe(50)
  })
})

describe('computeChildPathAndDepth', () => {
  it('root parent → child path and depth 1', () => {
    expect(computeChildPathAndDepth({ id: 'A', path: '', depth: 0 })).toEqual({
      path: '/A/',
      depth: 1,
    })
  })

  it('nested parent → extends path and increments depth', () => {
    expect(computeChildPathAndDepth({ id: 'C', path: '/A/B/', depth: 2 })).toEqual({
      path: '/A/B/C/',
      depth: 3,
    })
  })

  it('depth 49 parent → child at depth 50', () => {
    const result = computeChildPathAndDepth({ id: 'Z', path: 'long/path/', depth: 49 })
    expect(result.depth).toBe(50)
  })
})

describe('aiReviewParamsSchema', () => {
  it('accepts valid params with all fields', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: 'claude-sonnet-4-6',
      rubric: 'Check for correctness',
      customInstructions: 'Be concise',
    })
    expect(result.success).toBe(true)
  })

  it('accepts valid params without customInstructions', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: 'claude-opus-4-7',
      rubric: 'Quality check',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.customInstructions).toBeUndefined()
    }
  })

  it('rejects missing model', () => {
    const result = aiReviewParamsSchema.safeParse({
      rubric: 'Check for correctness',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing rubric', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: 'claude-sonnet-4-6',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty model string', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: '',
      rubric: 'Check for correctness',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty rubric string', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: 'claude-sonnet-4-6',
      rubric: '',
    })
    expect(result.success).toBe(false)
  })
  it('rejects model over 200 chars', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: 'x'.repeat(201),
      rubric: 'Check quality',
    })
    expect(result.success).toBe(false)
  })

  it('accepts model exactly 200 chars', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: 'x'.repeat(200),
      rubric: 'Check quality',
    })
    expect(result.success).toBe(true)
  })

  it('rejects rubric over 10000 chars', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: 'claude-sonnet-4-6',
      rubric: 'x'.repeat(10001),
    })
    expect(result.success).toBe(false)
  })

  it('accepts rubric exactly 10000 chars', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: 'claude-sonnet-4-6',
      rubric: 'x'.repeat(10000),
    })
    expect(result.success).toBe(true)
  })

  it('rejects customInstructions over 10000 chars', () => {
    const result = aiReviewParamsSchema.safeParse({
      model: 'claude-sonnet-4-6',
      rubric: 'Check quality',
      customInstructions: 'x'.repeat(10001),
    })
    expect(result.success).toBe(false)
  })
})

describe('roleMembershipCheck', () => {
  it('returns ok:true when all users are members', async () => {
    const mockPrisma = {
      orgMember: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]),
      },
    }
    const result = await roleMembershipCheck(mockPrisma as never, ['user-1', 'user-2'], 'org-1')
    expect(result).toEqual({ ok: true })
  })

  it('returns ok:false with missingId when a user is not a member', async () => {
    const mockPrisma = {
      orgMember: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'user-1' }]),
      },
    }
    const result = await roleMembershipCheck(
      mockPrisma as never,
      ['user-1', 'user-missing'],
      'org-1'
    )
    expect(result).toEqual({ ok: false, missingId: 'user-missing' })
  })

  it('returns ok:true for empty userIds array', async () => {
    const mockPrisma = {
      orgMember: {
        findMany: vi.fn(),
      },
    }
    const result = await roleMembershipCheck(mockPrisma as never, [], 'org-1')
    expect(result).toEqual({ ok: true })
    expect(mockPrisma.orgMember.findMany).not.toHaveBeenCalled()
  })

  it('deduplicates userIds before querying', async () => {
    const mockPrisma = {
      orgMember: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'user-1' }]),
      },
    }
    const result = await roleMembershipCheck(
      mockPrisma as never,
      ['user-1', 'user-1', 'user-1'],
      'org-1'
    )
    expect(result).toEqual({ ok: true })
    expect(mockPrisma.orgMember.findMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', userId: { in: ['user-1'] } },
      select: { userId: true },
    })
  })
})

describe('decodeAiReviewParams', () => {
  it('returns null for null input', () => {
    expect(decodeAiReviewParams(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(decodeAiReviewParams('')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(decodeAiReviewParams('not-json')).toBeNull()
  })

  it('returns null when parsed JSON fails schema validation', () => {
    expect(decodeAiReviewParams(JSON.stringify({ model: 'x' }))).toBeNull()
  })

  it('returns parsed object for valid JSON', () => {
    const params = { model: 'claude-sonnet-4-6', rubric: 'Check quality' }
    expect(decodeAiReviewParams(JSON.stringify(params))).toEqual(params)
  })

  it('returns parsed object with customInstructions', () => {
    const params = {
      model: 'claude-opus-4-7',
      rubric: 'Review code',
      customInstructions: 'Focus on security',
    }
    expect(decodeAiReviewParams(JSON.stringify(params))).toEqual(params)
  })
})
