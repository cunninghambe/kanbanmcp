/**
 * Tests for POST /api/cron/digest
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Mock the email module before importing the route
const mockSendEmail = vi.fn().mockResolvedValue({ messageId: 'mock-id' })
vi.mock('../../src/lib/email', () => ({
  sendEmail: mockSendEmail,
}))

const mockPrisma = {
  user: {
    findMany: vi.fn(),
  },
  card: {
    findMany: vi.fn(),
  },
}

vi.mock('../../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(authHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/cron/digest', {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

const CRON_SECRET = 'test-cron-secret'

describe('POST /api/cron/digest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', CRON_SECRET)
  })

  it('returns 401 without Authorization header', async () => {
    const { POST } = await import('../../src/app/api/cron/digest/route')
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong secret', async () => {
    const { POST } = await import('../../src/app/api/cron/digest/route')
    const res = await POST(makeRequest('Bearer wrong-secret'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when CRON_SECRET env is not set', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const { POST } = await import('../../src/app/api/cron/digest/route')
    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`))
    expect(res.status).toBe(401)
  })

  it('returns { sent: 0 } when no users have assignments', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'user-1', email: 'u@example.com', name: 'User', orgMembers: [{ orgId: 'org-1' }] },
    ])
    // All three findMany calls for this user return empty
    mockPrisma.card.findMany.mockResolvedValue([])

    const { POST } = await import('../../src/app/api/cron/digest/route')
    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sent).toBe(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('sends to each eligible user and returns correct count', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'user-1', email: 'alice@example.com', name: 'Alice', orgMembers: [{ orgId: 'org-1' }] },
      { id: 'user-2', email: 'bob@example.com', name: 'Bob', orgMembers: [{ orgId: 'org-1' }] },
    ])

    const assigneeCard = {
      id: 'card-1',
      title: 'Task',
      dueDate: null,
      board: { name: 'Board' },
      signoffs: [],
    }

    // user-1: has 1 assignee card; user-2: no cards
    mockPrisma.card.findMany
      .mockResolvedValueOnce([assigneeCard]) // user-1 assignee
      .mockResolvedValueOnce([]) // user-1 reviewer
      .mockResolvedValueOnce([]) // user-1 approver
      .mockResolvedValueOnce([]) // user-2 assignee
      .mockResolvedValueOnce([]) // user-2 reviewer
      .mockResolvedValueOnce([]) // user-2 approver

    const { POST } = await import('../../src/app/api/cron/digest/route')
    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sent).toBe(1)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).toHaveBeenCalledWith(
      'alice@example.com',
      'Your mhud daily digest',
      expect.any(String)
    )
  })

  it('skips users with no org memberships', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'user-orphan', email: 'orphan@example.com', name: 'Orphan', orgMembers: [] },
    ])

    const { POST } = await import('../../src/app/api/cron/digest/route')
    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`))
    const body = await res.json()
    expect(body.sent).toBe(0)
    expect(mockPrisma.card.findMany).not.toHaveBeenCalled()
  })
})
