/**
 * Authorization regression tests for the Gmail inbox agent.
 *
 * These encode a real vulnerability found in review: the route originally used
 * `requireOrgRole(session, session.orgId, 'MEMBER')`, which is a tautology —
 * every registered user is a MEMBER of their own org. Because the route targets
 * ONE mailbox via deployment-wide env, that authorized every account on the
 * instance (including unrelated orgs) to read any Gmail thread and send mail as
 * the mailbox owner. The fix is an explicit owner allowlist that fails closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockPrisma, sessionRef } = vi.hoisted(() => ({
  mockPrisma: {
    orgMember: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    apiKey: { findUnique: vi.fn(), update: vi.fn() },
  },
  sessionRef: { current: { userId: 'attacker-user', orgId: 'attacker-own-org' } as Record<string, unknown> },
}))

vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))
vi.mock('../../src/lib/agent-activity', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }))
vi.mock('iron-session', () => ({ getIronSession: vi.fn(async () => sessionRef.current) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockResolvedValue({}) }))

import { NextRequest } from 'next/server'
import { POST } from '../../src/app/api/inbox-agent/route'

const OWNER_EMAIL = 'owner@example.com'

function post(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/inbox-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function asUser(userId: string, orgId: string, email: string) {
  sessionRef.current = { userId, orgId }
  mockPrisma.orgMember.findUnique.mockResolvedValue({ userId, orgId, role: 'MEMBER' })
  mockPrisma.user.findUnique.mockResolvedValue({ email })
}

const draftBody = { action: 'draft', threadId: 'thread123', instructions: 'summarize' }

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.apiKey.findUnique.mockResolvedValue(null) // unknown key → 401 at requireSession
  process.env.INBOX_AGENT_URL = 'https://script.google.com/exec'
  process.env.INBOX_AGENT_TOKEN = 'server-side-only-token'
  process.env.INBOX_AGENT_OWNER = OWNER_EMAIL
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ json: async () => ({ draftId: 'd1', preview: 'PRIVATE THREAD', to: 'x@y.com' }) })
  )
})

afterEach(() => {
  delete process.env.INBOX_AGENT_OWNER
  vi.unstubAllGlobals()
})

describe('inbox agent authorization', () => {
  it('denies a registered user from an unrelated org (the original exploit)', async () => {
    asUser('attacker-user', 'attacker-own-org', 'attacker@evil.test')
    const res = await POST(post(draftBody))
    expect(res.status).toBe(403)
    expect(global.fetch).not.toHaveBeenCalled() // never reached the mailbox
  })

  it('denies a member of the OWNER\'s own org who is not the mailbox owner', async () => {
    asUser('colleague', 'owner-org', 'colleague@example.com')
    const res = await POST(post(draftBody))
    expect(res.status).toBe(403)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('denies sending as the owner', async () => {
    asUser('attacker-user', 'attacker-own-org', 'attacker@evil.test')
    const res = await POST(post({ action: 'send', draftId: 'd1' }))
    expect(res.status).toBe(403)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('allows the mailbox owner, and injects the token server-side', async () => {
    asUser('owner-user', 'owner-org', OWNER_EMAIL)
    const res = await POST(post(draftBody))
    expect(res.status).toBe(200)
    const sent = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(sent.token).toBe('server-side-only-token') // client never supplies it
    expect(sent.threadId).toBe('thread123')
  })

  it('matches the owner case-insensitively', async () => {
    asUser('owner-user', 'owner-org', 'Owner@Example.COM')
    expect((await POST(post(draftBody))).status).toBe(200)
  })

  it('FAILS CLOSED when no owner is configured — nobody is authorized', async () => {
    delete process.env.INBOX_AGENT_OWNER
    asUser('owner-user', 'owner-org', OWNER_EMAIL)
    const res = await POST(post(draftBody))
    expect(res.status).toBe(503)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects an API-key session outright', async () => {
    sessionRef.current = { userId: '', orgId: 'owner-org' }
    const req = new NextRequest('http://localhost/api/inbox-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer some-key' },
      body: JSON.stringify(draftBody),
    })
    // requireSession resolves API-key auth via the ApiKey table; with no match
    // it throws 401 — either way the mailbox is never reached.
    const res = await POST(req)
    expect([401, 403]).toContain(res.status)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed Gmail ids instead of relaying them upstream', async () => {
    asUser('owner-user', 'owner-org', OWNER_EMAIL)
    const res = await POST(post({ action: 'draft', threadId: 'https://evil.test/x', instructions: 'hi' }))
    expect(res.status).toBe(400)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rate-limits the owner to bound Anthropic spend and irreversible sends', async () => {
    asUser('owner-user', 'owner-org', OWNER_EMAIL)
    let limited = 0
    for (let i = 0; i < 25; i++) {
      const res = await POST(post(draftBody))
      if (res.status === 429) limited++
    }
    expect(limited).toBeGreaterThan(0)
  })
})
