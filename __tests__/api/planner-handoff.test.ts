/**
 * POST /api/planner/drafts/[id]/handoff — spec §5.6: every kind, the owner-gated
 * two-step email with the server-stored pendingEmail, per-kind rate limits,
 * error mapping, handoff records and provenance. (WI-4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'

const mockRequireSession = vi.fn()
const mockRequireOrgRole = vi.fn()
vi.mock('../../src/lib/api-helpers', () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
  requireOrgRole: (...args: unknown[]) => mockRequireOrgRole(...args),
  apiError: (status: number, msg: string) => {
    const { NextResponse } = require('next/server')
    return NextResponse.json({ error: msg }, { status })
  },
}))

const mockPrisma = vi.hoisted(() => ({
  plannerDraft: { findFirst: vi.fn(), update: vi.fn() },
  plannerItem: { findFirst: vi.fn() },
}))
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const activity = vi.hoisted(() => ({ logActivity: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/lib/agent-activity', () => ({
  logActivity: (...a: unknown[]) => activity.logActivity(...a),
}))

const owner = vi.hoisted(() => ({ assertInboxOwner: vi.fn() }))
vi.mock('../../src/lib/inbox-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/inbox-agent')>()
  return { ...actual, assertInboxOwner: (...a: unknown[]) => owner.assertInboxOwner(...a) }
})

const email = vi.hoisted(() => ({ composeEmailDraft: vi.fn(), sendEmailDraft: vi.fn() }))
vi.mock('../../src/lib/planner/handoffs/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/planner/handoffs/email')>()
  return {
    ...actual,
    composeEmailDraft: (...a: unknown[]) => email.composeEmailDraft(...a),
    sendEmailDraft: (...a: unknown[]) => email.sendEmailDraft(...a),
  }
})
const gdoc = vi.hoisted(() => ({ handoffGoogleDoc: vi.fn() }))
vi.mock('../../src/lib/planner/handoffs/gdoc', () => ({
  handoffGoogleDoc: (...a: unknown[]) => gdoc.handoffGoogleDoc(...a),
}))
const cardh = vi.hoisted(() => ({ handoffCardComment: vi.fn(), handoffCardCreate: vi.fn() }))
vi.mock('../../src/lib/planner/handoffs/card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/planner/handoffs/card')>()
  return {
    ...actual,
    handoffCardComment: (...a: unknown[]) => cardh.handoffCardComment(...a),
    handoffCardCreate: (...a: unknown[]) => cardh.handoffCardCreate(...a),
  }
})
const slackh = vi.hoisted(() => ({ handoffSlackPost: vi.fn() }))
vi.mock('../../src/lib/planner/handoffs/slack', () => ({
  handoffSlackPost: (...a: unknown[]) => slackh.handoffSlackPost(...a),
}))

import { __resetRateLimitStore } from '../../src/lib/rate-limit'
import {
  InboxAgentUnconfiguredError,
  InboxAgentUpstreamError,
  hashBody,
} from '../../src/lib/planner/handoffs/email'
import {
  AssigneeNotMemberError,
  BoardNotFoundError,
  CardNotFoundError,
  ColumnNotOnBoardError,
} from '../../src/lib/planner/handoffs/card'
import {
  GoogleAuthExpiredError,
  InsufficientScopesError,
  TokenRevokedError,
} from '../../src/lib/google/errors'
import { SlackApiError, SlackAuthError } from '../../src/lib/slack/errors'

const HUMAN = { userId: 'user-1', orgId: 'org-1' }
const APIKEY = { userId: '', orgId: 'org-1', isApiKeyAuth: true, agentName: 'bot' }
const NOW = new Date('2026-09-16T09:00:00Z')
const BODY = 'Hi Jane,\n\nThursday works for me.\n\nBeth'
const HASH = createHash('sha256').update(BODY).digest('hex')
const ctx = { params: Promise.resolve({ id: 'd-1' }) }

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/planner/drafts/d-1/handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function draft(over: Record<string, unknown> = {}) {
  return {
    id: 'd-1',
    orgId: 'org-1',
    userId: 'user-1',
    itemId: 'it-1',
    title: 'Re: Jane',
    body: BODY,
    status: 'draft',
    handoff: null,
    pendingEmail: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function emailItem(over: Record<string, unknown> = {}) {
  return {
    id: 'it-1',
    orgId: 'org-1',
    userId: 'user-1',
    source: 'email',
    sourceKey: 'email:e1',
    title: 'Reply to Jane',
    summary: null,
    url: null,
    priority: 'medium',
    dueAt: null,
    startsAt: null,
    endsAt: null,
    status: 'open',
    snoozedUntil: null,
    resolvedBy: null,
    resolvedAt: null,
    prepNotes: null,
    payload: '{"cardId":"c1","boardId":"inbox","gmailThreadId":"thread123","nudgeId":null}',
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

const PENDING = {
  gmailDraftId: 'r-777',
  to: 'jane@example.com',
  cc: '',
  threadId: 'thread123',
  bodyHash: HASH,
  at: NOW.toISOString(),
}

async function handoff(body: unknown) {
  const { POST } = await import('../../src/app/api/planner/drafts/[id]/handoff/route')
  const res = await POST(req(body), ctx)
  return { res, body: await res.json().catch(() => ({})) }
}

function lastUpdate() {
  const calls = mockPrisma.plannerDraft.update.mock.calls
  return calls[calls.length - 1][0]
}

describe('POST /api/planner/drafts/[id]/handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    __resetRateLimitStore()
    vi.stubEnv('PLANNER_SEND_WINDOW_MS', '')
    mockRequireSession.mockResolvedValue(HUMAN)
    mockRequireOrgRole.mockResolvedValue({ role: 'MEMBER' })
    owner.assertInboxOwner.mockResolvedValue(undefined)
    mockPrisma.plannerDraft.findFirst.mockResolvedValue(draft())
    mockPrisma.plannerDraft.update.mockImplementation(
      async (a: { data: Record<string, unknown> }) => draft(a.data)
    )
    mockPrisma.plannerItem.findFirst.mockResolvedValue(emailItem())
    email.composeEmailDraft.mockResolvedValue({
      gmailDraftId: 'r-777',
      preview: BODY,
      to: 'jane@example.com',
      cc: '',
      bodyHash: HASH,
    })
    email.sendEmailDraft.mockResolvedValue({ sent: true, messageId: 'm-1' })
    gdoc.handoffGoogleDoc.mockResolvedValue({
      id: 'doc1',
      url: 'https://docs.google.com/document/d/doc1/edit',
    })
    cardh.handoffCardComment.mockResolvedValue({ commentId: 'cm-1', cardId: 'c1', boardId: 'b1' })
    cardh.handoffCardCreate.mockResolvedValue({ cardId: 'c-new', boardId: 'b1', columnId: 'col-1' })
    slackh.handoffSlackPost.mockResolvedValue({
      channel: 'C1',
      ts: '1.2',
      url: 'https://acme.slack.com/archives/C1/p12',
    })
  })
  afterEach(() => vi.useRealTimers())

  describe('common gates', () => {
    it('403 for API keys, 404 for a foreign draft, 400 for an unknown kind or empty body', async () => {
      mockRequireSession.mockResolvedValue(APIKEY)
      expect((await handoff({ kind: 'gdoc' })).res.status).toBe(403)
      mockRequireSession.mockResolvedValue(HUMAN)

      mockPrisma.plannerDraft.findFirst.mockResolvedValue(null)
      const nf = await handoff({ kind: 'gdoc' })
      expect(nf.res.status).toBe(404)
      expect(nf.body.error).toBe('Draft not found')
      expect(mockPrisma.plannerDraft.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'd-1', userId: 'user-1' }) })
      )

      mockPrisma.plannerDraft.findFirst.mockResolvedValue(draft())
      expect((await handoff({ kind: 'fax' })).res.status).toBe(400)
      expect((await handoff({})).res.status).toBe(400)

      mockPrisma.plannerDraft.findFirst.mockResolvedValue(draft({ body: '   \n' }))
      const empty = await handoff({ kind: 'gdoc' })
      expect(empty.res.status).toBe(400)
      expect(empty.body.error).toBe('Draft body is empty')
      expect(gdoc.handoffGoogleDoc).not.toHaveBeenCalled()
    })
  })

  describe('email_compose', () => {
    it('is owner-gated: 403 / 503 from assertInboxOwner pass through untouched and nothing is composed', async () => {
      owner.assertInboxOwner.mockRejectedValue(
        NextResponse.json(
          { error: 'Forbidden: this mailbox belongs to another user' },
          { status: 403 }
        )
      )
      const a = await handoff({ kind: 'email_compose' })
      expect(a.res.status).toBe(403)
      expect(a.body.error).toBe('Forbidden: this mailbox belongs to another user')

      owner.assertInboxOwner.mockRejectedValue(
        NextResponse.json(
          { error: 'Inbox agent is not configured (INBOX_AGENT_OWNER unset)' },
          { status: 503 }
        )
      )
      expect((await handoff({ kind: 'email_compose' })).res.status).toBe(503)
      expect(email.composeEmailDraft).not.toHaveBeenCalled()
      expect(owner.assertInboxOwner).toHaveBeenCalledWith(HUMAN)
    })

    it("replies on the item's thread, persists pendingEmail with the body hash, and keeps the draft status", async () => {
      const { res, body } = await handoff({ kind: 'email_compose', replyAll: true })
      expect(res.status).toBe(200)
      expect(email.composeEmailDraft).toHaveBeenCalledWith(HUMAN, {
        threadId: 'thread123',
        body: BODY,
        replyAll: true,
      })
      const upd = lastUpdate()
      expect(upd.where).toEqual({ id: 'd-1' })
      expect(upd.data).not.toHaveProperty('status')
      expect(JSON.parse(upd.data.pendingEmail)).toEqual(PENDING)
      expect(body.result.pendingEmail).toEqual(PENDING)
      expect(body.draft.pendingEmail).toEqual(PENDING)
      expect(body.draft.status).toBe('draft')
    })

    it('composes a new message when to + subject are given, even without an email item', async () => {
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(draft({ itemId: null }))
      const { res } = await handoff({
        kind: 'email_compose',
        to: 'bob@example.com',
        subject: 'Plan',
      })
      expect(res.status).toBe(200)
      expect(email.composeEmailDraft).toHaveBeenCalledWith(HUMAN, {
        to: 'bob@example.com',
        subject: 'Plan',
        body: BODY,
        replyAll: undefined,
      })
      expect(JSON.parse(lastUpdate().data.pendingEmail).threadId).toBeNull()
    })

    it('400 when the draft is not linked to an email thread and no recipient was given', async () => {
      mockPrisma.plannerItem.findFirst.mockResolvedValue(
        emailItem({ source: 'card', payload: '{"cardId":"c1"}' })
      )
      const { res, body } = await handoff({ kind: 'email_compose' })
      expect(res.status).toBe(400)
      expect(body.error).toBe('This draft is not linked to an email thread; provide to and subject')
      expect((await handoff({ kind: 'email_compose', to: 'bob@example.com' })).res.status).toBe(400)
      expect(
        (await handoff({ kind: 'email_compose', to: 'bob@example.com', subject: 'x'.repeat(301) }))
          .res.status
      ).toBe(400)
    })

    it('maps inbox-agent failures to fixed messages (no upstream detail) and is limited to 10 per 10 minutes', async () => {
      email.composeEmailDraft.mockRejectedValue(new InboxAgentUnconfiguredError('x'))
      const a = await handoff({ kind: 'email_compose' })
      expect(a.res.status).toBe(503)
      expect(a.body.error).toBe('Inbox agent is not configured')
      email.composeEmailDraft.mockRejectedValue(
        new InboxAgentUpstreamError('thread not found: secret-id')
      )
      const b = await handoff({ kind: 'email_compose' })
      expect(b.res.status).toBe(502)
      expect(b.body.error).toBe('Inbox agent rejected the request')
      expect(JSON.stringify(b.body)).not.toContain('secret-id')

      __resetRateLimitStore()
      email.composeEmailDraft.mockResolvedValue({
        gmailDraftId: 'r',
        preview: BODY,
        to: 'j',
        cc: '',
        bodyHash: HASH,
      })
      for (let i = 0; i < 10; i++)
        expect((await handoff({ kind: 'email_compose' })).res.status).toBe(200)
      expect((await handoff({ kind: 'email_compose' })).res.status).toBe(429)
    })
  })

  describe('email_send', () => {
    it('sends only the server-stored Gmail draft, logs provenance with the stored recipients, marks the draft handed off and clears pendingEmail', async () => {
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(
        draft({ pendingEmail: JSON.stringify(PENDING) })
      )
      const { res, body } = await handoff({ kind: 'email_send' })
      expect(res.status).toBe(200)
      expect(owner.assertInboxOwner).toHaveBeenCalledWith(HUMAN)
      expect(email.sendEmailDraft).toHaveBeenCalledWith(HUMAN, 'r-777')
      expect(activity.logActivity).toHaveBeenCalledWith(
        'org-1',
        'planner',
        'send',
        'gmail_thread',
        'thread123',
        { gmailDraftId: 'r-777', plannerDraftId: 'd-1', to: 'jane@example.com', cc: '' }
      )
      const upd = lastUpdate()
      expect(upd.data.status).toBe('handed_off')
      expect(upd.data.pendingEmail).toBeNull()
      expect(JSON.parse(upd.data.handoff)).toEqual({
        kind: 'email',
        ref: 'm-1',
        at: NOW.toISOString(),
      })
      expect(body.result).toEqual({ messageId: 'm-1', to: 'jane@example.com', cc: '' })
      expect(body.draft.status).toBe('handed_off')
      expect(body.handoff).toEqual({ kind: 'email', ref: 'm-1', at: NOW.toISOString() })
    })

    it('ignores any client-supplied draft id', async () => {
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(
        draft({ pendingEmail: JSON.stringify(PENDING) })
      )
      await handoff({ kind: 'email_send', draftId: 'r-ATTACKER' })
      expect(email.sendEmailDraft).toHaveBeenCalledWith(HUMAN, 'r-777')
    })

    it('400 without a compose, 409 when the body changed or the window elapsed; never sends', async () => {
      const a = await handoff({ kind: 'email_send' })
      expect(a.res.status).toBe(400)
      expect(a.body.error).toBe('Compose the email before sending')

      mockPrisma.plannerDraft.findFirst.mockResolvedValue(
        draft({ body: BODY + ' (edited)', pendingEmail: JSON.stringify(PENDING) })
      )
      const b = await handoff({ kind: 'email_send' })
      expect(b.res.status).toBe(409)
      expect(b.body.error).toBe('The draft changed since it was composed; re-compose to send')

      mockPrisma.plannerDraft.findFirst.mockResolvedValue(
        draft({
          pendingEmail: JSON.stringify({
            ...PENDING,
            at: new Date(NOW.getTime() - 11 * 60_000).toISOString(),
          }),
        })
      )
      expect((await handoff({ kind: 'email_send' })).res.status).toBe(409)

      vi.stubEnv('PLANNER_SEND_WINDOW_MS', String(30 * 60_000))
      expect((await handoff({ kind: 'email_send' })).res.status).toBe(200)
      expect(email.sendEmailDraft).toHaveBeenCalledTimes(1)
    })

    it('is owner-gated and limited to 10 per 10 minutes', async () => {
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(
        draft({ pendingEmail: JSON.stringify(PENDING) })
      )
      owner.assertInboxOwner.mockRejectedValueOnce(
        NextResponse.json(
          { error: 'Forbidden: this mailbox belongs to another user' },
          { status: 403 }
        )
      )
      expect((await handoff({ kind: 'email_send' })).res.status).toBe(403)
      expect(email.sendEmailDraft).not.toHaveBeenCalled()

      for (let i = 0; i < 10; i++)
        expect((await handoff({ kind: 'email_send' })).res.status).toBe(200)
      expect((await handoff({ kind: 'email_send' })).res.status).toBe(429)
    })

    it('maps upstream failures to a fixed 502 without marking the draft handed off', async () => {
      mockPrisma.plannerDraft.findFirst.mockResolvedValue(
        draft({ pendingEmail: JSON.stringify(PENDING) })
      )
      email.sendEmailDraft.mockRejectedValue(new InboxAgentUpstreamError('draft not found'))
      const { res, body } = await handoff({ kind: 'email_send' })
      expect(res.status).toBe(502)
      expect(body.error).toBe('Inbox agent rejected the request')
      expect(
        mockPrisma.plannerDraft.update.mock.calls.some((c) => c[0].data.status === 'handed_off')
      ).toBe(false)
      expect(activity.logActivity).not.toHaveBeenCalled()
    })

    it('hashBody is sha256 hex of the exact body', () => {
      expect(hashBody(BODY)).toBe(HASH)
      expect(hashBody(BODY + ' ')).not.toBe(HASH)
    })
  })

  describe('gdoc', () => {
    it('creates the doc from the draft, records the handoff and logs provenance', async () => {
      const { res, body } = await handoff({ kind: 'gdoc', folderId: 'f1' })
      expect(res.status).toBe(200)
      expect(gdoc.handoffGoogleDoc).toHaveBeenCalledWith({
        userId: 'user-1',
        title: 'Re: Jane',
        markdown: BODY,
        folderId: 'f1',
      })
      expect(activity.logActivity).toHaveBeenCalledWith(
        'org-1',
        'planner',
        'create_doc',
        'google_doc',
        'doc1',
        expect.objectContaining({ plannerDraftId: 'd-1' })
      )
      expect(JSON.parse(lastUpdate().data.handoff)).toEqual({
        kind: 'gdoc',
        ref: 'doc1',
        url: 'https://docs.google.com/document/d/doc1/edit',
        at: NOW.toISOString(),
      })
      expect(lastUpdate().data.status).toBe('handed_off')
      expect(body.result).toEqual({
        id: 'doc1',
        url: 'https://docs.google.com/document/d/doc1/edit',
      })
    })

    it('409 INSUFFICIENT_SCOPES with an upgrade url, 409 GOOGLE_NOT_CONNECTED, and a 10 / 10 min limit', async () => {
      gdoc.handoffGoogleDoc.mockRejectedValue(
        new InsufficientScopesError(['https://www.googleapis.com/auth/drive.file'])
      )
      const a = await handoff({ kind: 'gdoc' })
      expect(a.res.status).toBe(409)
      expect(a.body).toEqual({
        error: 'INSUFFICIENT_SCOPES',
        missing: ['https://www.googleapis.com/auth/drive.file'],
        upgradeUrl: '/api/me/google/connect?upgrade=planner',
      })

      gdoc.handoffGoogleDoc.mockRejectedValue(new GoogleAuthExpiredError())
      const b = await handoff({ kind: 'gdoc' })
      expect(b.res.status).toBe(409)
      expect(b.body.error).toBe('GOOGLE_NOT_CONNECTED')
      expect(mockPrisma.plannerDraft.update).not.toHaveBeenCalled()

      // a revoked refresh token is the same user-facing state, never a 500
      gdoc.handoffGoogleDoc.mockRejectedValue(new TokenRevokedError())
      const c = await handoff({ kind: 'gdoc' })
      expect(c.res.status).toBe(409)
      expect(c.body.error).toBe('GOOGLE_NOT_CONNECTED')

      __resetRateLimitStore()
      gdoc.handoffGoogleDoc.mockResolvedValue({
        id: 'd',
        url: 'https://docs.google.com/document/d/d/edit',
      })
      for (let i = 0; i < 10; i++) expect((await handoff({ kind: 'gdoc' })).res.status).toBe(200)
      expect((await handoff({ kind: 'gdoc' })).res.status).toBe(429)
    })
  })

  describe('card_comment / card_create', () => {
    it('comments with the title prepended, links the card and records the handoff', async () => {
      const { res, body } = await handoff({ kind: 'card_comment', cardId: 'c1' })
      expect(res.status).toBe(200)
      expect(cardh.handoffCardComment).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-1',
          userId: 'user-1',
          cardId: 'c1',
          content: `**Re: Jane**\n\n${BODY}`,
        })
      )
      expect(JSON.parse(lastUpdate().data.handoff)).toEqual({
        kind: 'card_comment',
        ref: 'cm-1',
        url: '/board/b1?card=c1',
        at: NOW.toISOString(),
      })
      expect(body.result).toEqual({ commentId: 'cm-1', cardId: 'c1', boardId: 'b1' })
    })

    it('creates a card with the draft title/body and maps the error classes', async () => {
      const { res, body } = await handoff({
        kind: 'card_create',
        boardId: 'b1',
        columnId: 'col-1',
        assigneeId: 'user-2',
      })
      expect(res.status).toBe(200)
      expect(cardh.handoffCardCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-1',
          userId: 'user-1',
          boardId: 'b1',
          columnId: 'col-1',
          assigneeId: 'user-2',
          title: 'Re: Jane',
          description: BODY,
        })
      )
      expect(JSON.parse(lastUpdate().data.handoff)).toEqual({
        kind: 'card_create',
        ref: 'c-new',
        url: '/board/b1?card=c-new',
        at: NOW.toISOString(),
      })
      expect(body.result).toEqual({ cardId: 'c-new', boardId: 'b1', columnId: 'col-1' })

      cardh.handoffCardCreate.mockRejectedValue(new ColumnNotOnBoardError('x'))
      const a = await handoff({ kind: 'card_create', boardId: 'b1', columnId: 'nope' })
      expect(a.res.status).toBe(400)
      expect(a.body.error).toBe('Column does not belong to this board')
      cardh.handoffCardCreate.mockRejectedValue(new AssigneeNotMemberError('x'))
      const b = await handoff({ kind: 'card_create', boardId: 'b1', assigneeId: 'stranger' })
      expect(b.res.status).toBe(400)
      expect(b.body.error).toBe('assigneeId must be a member of this organization')
      cardh.handoffCardCreate.mockRejectedValue(new BoardNotFoundError('x'))
      const c = await handoff({ kind: 'card_create', boardId: 'other-org' })
      expect(c.res.status).toBe(404)
      expect(c.body.error).toBe('Board not found')
      cardh.handoffCardComment.mockRejectedValue(new CardNotFoundError('x'))
      const d = await handoff({ kind: 'card_comment', cardId: 'other-org' })
      expect(d.res.status).toBe(404)
      expect(d.body.error).toBe('Card not found')
      expect((await handoff({ kind: 'card_comment' })).res.status).toBe(400)
      expect((await handoff({ kind: 'card_create' })).res.status).toBe(400)
    })
  })

  describe('slack', () => {
    it('posts the draft (threaded when asked), records the handoff and logs provenance', async () => {
      const { res, body } = await handoff({ kind: 'slack', channel: 'C1', threadTs: '1.0' })
      expect(res.status).toBe(200)
      expect(slackh.handoffSlackPost).toHaveBeenCalledWith({
        userId: 'user-1',
        channel: 'C1',
        markdown: BODY,
        threadTs: '1.0',
      })
      expect(activity.logActivity).toHaveBeenCalledWith(
        'org-1',
        'planner',
        'post_message',
        'slack_message',
        'C1:1.2',
        expect.objectContaining({ plannerDraftId: 'd-1' })
      )
      expect(JSON.parse(lastUpdate().data.handoff)).toEqual({
        kind: 'slack',
        ref: 'C1:1.2',
        url: 'https://acme.slack.com/archives/C1/p12',
        at: NOW.toISOString(),
      })
      expect(body.result).toEqual({
        channel: 'C1',
        ts: '1.2',
        url: 'https://acme.slack.com/archives/C1/p12',
      })
    })

    it('409 SLACK_NOT_CONNECTED, 502 with the Slack error code, validation, and a 20 / 10 min limit', async () => {
      slackh.handoffSlackPost.mockRejectedValue(new SlackAuthError('no cred'))
      const a = await handoff({ kind: 'slack', channel: 'C1' })
      expect(a.res.status).toBe(409)
      expect(a.body.error).toBe('SLACK_NOT_CONNECTED')

      slackh.handoffSlackPost.mockRejectedValue(new SlackApiError('not_in_channel'))
      const b = await handoff({ kind: 'slack', channel: 'C1' })
      expect(b.res.status).toBe(502)
      expect(b.body).toEqual({ error: 'Slack rejected the message', slackError: 'not_in_channel' })

      expect((await handoff({ kind: 'slack' })).res.status).toBe(400)

      __resetRateLimitStore()
      slackh.handoffSlackPost.mockResolvedValue({ channel: 'C1', ts: '1', url: null })
      for (let i = 0; i < 20; i++)
        expect((await handoff({ kind: 'slack', channel: 'C1' })).res.status).toBe(200)
      expect((await handoff({ kind: 'slack', channel: 'C1' })).res.status).toBe(429)
    })
  })
})
