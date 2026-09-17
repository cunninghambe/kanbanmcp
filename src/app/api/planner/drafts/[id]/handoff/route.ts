// POST /api/planner/drafts/[id]/handoff — spec §5.6.
//
// Every kind that leaves the app is rate limited per user and writes an
// AgentActivity row with `agentName: 'planner'`. The email path is the strict
// one: `assertInboxOwner` before any rate limit or network call, and the send
// uses only the `pendingEmail` record the server itself wrote — a Gmail draft
// id in the request body is ignored, and a body edit or an elapsed window makes
// the stored record unusable (409).

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { logActivity } from '@/lib/agent-activity'
import { apiError, requireOrgRole, requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import {
  GoogleAuthExpiredError,
  InsufficientScopesError,
  TokenRevokedError,
} from '@/lib/google/errors'
import { assertInboxOwner } from '@/lib/inbox-agent'
import { checkRateLimit } from '@/lib/rate-limit'
import { SlackApiError, SlackAuthError } from '@/lib/slack/errors'
import {
  AssigneeNotMemberError,
  BoardNotFoundError,
  CardNotFoundError,
  ColumnNotOnBoardError,
  handoffCardComment,
  handoffCardCreate,
} from '@/lib/planner/handoffs/card'
import {
  InboxAgentUnconfiguredError,
  InboxAgentUpstreamError,
  composeEmailDraft,
  hashBody,
  sendEmailDraft,
} from '@/lib/planner/handoffs/email'
import type { ComposeArgs } from '@/lib/planner/handoffs/email'
import { handoffGoogleDoc } from '@/lib/planner/handoffs/gdoc'
import { handoffSlackPost } from '@/lib/planner/handoffs/slack'
import { toPlannerDraftDTO } from '@/lib/planner/types'
import type { PendingEmail, PlannerHandoffRecord } from '@/lib/planner/types'
import type { PlannerDraft } from '@prisma/client'
import type { SessionData } from '@/lib/session'

const MINUTES_10 = 10 * 60_000
const SEND_WINDOW_MS_DEFAULT = 600_000
const UPGRADE_URL = '/api/me/google/connect?upgrade=planner'

const bodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email_compose'),
    replyAll: z.boolean().optional(),
    to: z.string().min(1).max(500).optional(),
    subject: z.string().min(1).max(300).optional(),
  }),
  z.object({ kind: z.literal('email_send') }),
  z.object({ kind: z.literal('gdoc'), folderId: z.string().min(1).optional() }),
  z.object({ kind: z.literal('card_comment'), cardId: z.string().min(1) }),
  z.object({
    kind: z.literal('card_create'),
    boardId: z.string().min(1),
    columnId: z.string().min(1).optional(),
    assigneeId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('slack'),
    channel: z.string().min(1),
    threadTs: z.string().min(1).optional(),
  }),
])

type HandoffBody = z.infer<typeof bodySchema>

function sendWindowMs(): number {
  const raw = Number(process.env.PLANNER_SEND_WINDOW_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : SEND_WINDOW_MS_DEFAULT
}

/** The Gmail thread this draft's item is about, when it has one. */
async function threadIdForDraft(draft: PlannerDraft, session: SessionData): Promise<string | null> {
  if (!draft.itemId) return null
  const item = await prisma.plannerItem.findFirst({
    where: { id: draft.itemId, userId: session.userId, orgId: session.orgId },
    select: { payload: true },
  })
  if (!item) return null
  try {
    const payload: unknown = JSON.parse(item.payload)
    if (!payload || typeof payload !== 'object') return null
    const threadId = (payload as Record<string, unknown>).gmailThreadId
    return typeof threadId === 'string' && threadId ? threadId : null
  } catch {
    return null
  }
}

/** Fixed messages only — upstream detail stays in the server log (PR #38). */
function mapInboxAgentError(err: unknown): NextResponse | null {
  if (err instanceof InboxAgentUnconfiguredError) {
    return apiError(503, 'Inbox agent is not configured')
  }
  if (err instanceof InboxAgentUpstreamError) {
    console.error('planner inbox-agent upstream failure:', err.detail)
    return apiError(502, 'Inbox agent rejected the request')
  }
  return null
}

async function finishHandoff(
  draftId: string,
  record: PlannerHandoffRecord,
  result: Record<string, unknown>
): Promise<NextResponse> {
  const updated = await prisma.plannerDraft.update({
    where: { id: draftId },
    data: { status: 'handed_off', handoff: JSON.stringify(record) },
  })
  return NextResponse.json({ draft: toPlannerDraftDTO(updated), handoff: record, result })
}

async function handleEmailCompose(
  session: SessionData,
  draft: PlannerDraft,
  data: Extract<HandoffBody, { kind: 'email_compose' }>
): Promise<NextResponse> {
  await assertInboxOwner(session)
  if (!checkRateLimit(`planner-email-compose:${session.userId}`, 10, MINUTES_10)) {
    return apiError(429, 'Too many email drafts. Try again in a few minutes.')
  }

  const notLinked = 'This draft is not linked to an email thread; provide to and subject'
  let args: ComposeArgs
  let threadId: string | null = null
  if (data.to !== undefined) {
    if (!data.subject) return apiError(400, notLinked)
    args = { to: data.to, subject: data.subject, body: draft.body, replyAll: data.replyAll }
  } else {
    threadId = await threadIdForDraft(draft, session)
    if (!threadId) return apiError(400, notLinked)
    args = { threadId, body: draft.body, replyAll: data.replyAll }
  }

  let composed
  try {
    composed = await composeEmailDraft(session, args)
  } catch (err) {
    const mapped = mapInboxAgentError(err)
    if (mapped) return mapped
    throw err
  }

  const pendingEmail: PendingEmail = {
    gmailDraftId: composed.gmailDraftId,
    to: composed.to,
    cc: composed.cc,
    threadId,
    bodyHash: composed.bodyHash,
    at: new Date().toISOString(),
  }
  const updated = await prisma.plannerDraft.update({
    where: { id: draft.id },
    data: { pendingEmail: JSON.stringify(pendingEmail) },
  })
  const dto = toPlannerDraftDTO(updated)
  // `preview` is the text as the server composed it: the UI shows that, not its local copy.
  return NextResponse.json({
    draft: dto,
    handoff: dto.handoff,
    result: { pendingEmail, preview: composed.preview },
  })
}

async function handleEmailSend(session: SessionData, draft: PlannerDraft): Promise<NextResponse> {
  await assertInboxOwner(session)
  if (!checkRateLimit(`planner-email-send:${session.userId}`, 10, MINUTES_10)) {
    return apiError(429, 'Too many sends. Try again in a few minutes.')
  }

  const pending = toPlannerDraftDTO(draft).pendingEmail
  if (!pending) return apiError(400, 'Compose the email before sending')

  const composedAt = Date.parse(pending.at)
  const stale = !Number.isFinite(composedAt) || Date.now() - composedAt > sendWindowMs()
  if (hashBody(draft.body) !== pending.bodyHash || stale) {
    return apiError(409, 'The draft changed since it was composed; re-compose to send')
  }

  let sent
  try {
    // The stored id only — a client-supplied Gmail draft id is never relayed.
    sent = await sendEmailDraft(session, pending.gmailDraftId)
  } catch (err) {
    const mapped = mapInboxAgentError(err)
    if (mapped) return mapped
    throw err
  }

  logActivity(
    session.orgId,
    'planner',
    'send',
    'gmail_thread',
    pending.threadId ?? pending.gmailDraftId,
    {
      gmailDraftId: pending.gmailDraftId,
      plannerDraftId: draft.id,
      to: pending.to,
      cc: pending.cc,
    }
  ).catch(() => {})

  const record: PlannerHandoffRecord = {
    kind: 'email',
    ref: sent.messageId,
    at: new Date().toISOString(),
  }
  const updated = await prisma.plannerDraft.update({
    where: { id: draft.id },
    data: { status: 'handed_off', handoff: JSON.stringify(record), pendingEmail: null },
  })
  return NextResponse.json({
    draft: toPlannerDraftDTO(updated),
    handoff: record,
    result: { messageId: sent.messageId, to: pending.to, cc: pending.cc },
  })
}

async function handleGdoc(
  session: SessionData,
  draft: PlannerDraft,
  data: Extract<HandoffBody, { kind: 'gdoc' }>
): Promise<NextResponse> {
  if (!checkRateLimit(`planner-gdoc:${session.userId}`, 10, MINUTES_10)) {
    return apiError(429, 'Too many documents. Try again in a few minutes.')
  }

  let doc
  try {
    doc = await handoffGoogleDoc({
      userId: session.userId,
      title: draft.title,
      markdown: draft.body,
      folderId: data.folderId,
    })
  } catch (err) {
    if (err instanceof InsufficientScopesError) {
      return NextResponse.json(
        { error: 'INSUFFICIENT_SCOPES', missing: err.missing, upgradeUrl: UPGRADE_URL },
        { status: 409 }
      )
    }
    if (err instanceof GoogleAuthExpiredError || err instanceof TokenRevokedError) {
      return apiError(409, 'GOOGLE_NOT_CONNECTED')
    }
    throw err
  }

  logActivity(session.orgId, 'planner', 'create_doc', 'google_doc', doc.id, {
    plannerDraftId: draft.id,
    url: doc.url,
  }).catch(() => {})

  return finishHandoff(
    draft.id,
    { kind: 'gdoc', ref: doc.id, url: doc.url, at: new Date().toISOString() },
    { id: doc.id, url: doc.url }
  )
}

async function handleCardComment(
  session: SessionData,
  draft: PlannerDraft,
  data: Extract<HandoffBody, { kind: 'card_comment' }>
): Promise<NextResponse> {
  const title = draft.title.trim()
  const content = title ? `**${title}**\n\n${draft.body}` : draft.body

  let comment
  try {
    comment = await handoffCardComment({
      prisma,
      orgId: session.orgId,
      userId: session.userId,
      cardId: data.cardId,
      content,
    })
  } catch (err) {
    if (err instanceof CardNotFoundError) return apiError(404, 'Card not found')
    throw err
  }

  return finishHandoff(
    draft.id,
    {
      kind: 'card_comment',
      ref: comment.commentId,
      url: `/board/${comment.boardId}?card=${comment.cardId}`,
      at: new Date().toISOString(),
    },
    comment as unknown as Record<string, unknown>
  )
}

async function handleCardCreate(
  session: SessionData,
  draft: PlannerDraft,
  data: Extract<HandoffBody, { kind: 'card_create' }>
): Promise<NextResponse> {
  let card
  try {
    card = await handoffCardCreate({
      prisma,
      orgId: session.orgId,
      userId: session.userId,
      boardId: data.boardId,
      columnId: data.columnId,
      assigneeId: data.assigneeId,
      title: draft.title,
      description: draft.body,
    })
  } catch (err) {
    if (err instanceof ColumnNotOnBoardError) {
      return apiError(400, 'Column does not belong to this board')
    }
    if (err instanceof AssigneeNotMemberError) {
      return apiError(400, 'assigneeId must be a member of this organization')
    }
    if (err instanceof BoardNotFoundError) return apiError(404, 'Board not found')
    throw err
  }

  return finishHandoff(
    draft.id,
    {
      kind: 'card_create',
      ref: card.cardId,
      url: `/board/${card.boardId}?card=${card.cardId}`,
      at: new Date().toISOString(),
    },
    card as unknown as Record<string, unknown>
  )
}

async function handleSlack(
  session: SessionData,
  draft: PlannerDraft,
  data: Extract<HandoffBody, { kind: 'slack' }>
): Promise<NextResponse> {
  if (!checkRateLimit(`planner-slack:${session.userId}`, 20, MINUTES_10)) {
    return apiError(429, 'Too many Slack posts. Try again in a few minutes.')
  }

  let posted
  try {
    posted = await handoffSlackPost({
      userId: session.userId,
      channel: data.channel,
      markdown: draft.body,
      threadTs: data.threadTs,
    })
  } catch (err) {
    if (err instanceof SlackAuthError) return apiError(409, 'SLACK_NOT_CONNECTED')
    if (err instanceof SlackApiError) {
      return NextResponse.json(
        { error: 'Slack rejected the message', slackError: err.slackError },
        { status: 502 }
      )
    }
    throw err
  }

  const ref = `${posted.channel}:${posted.ts}`
  logActivity(session.orgId, 'planner', 'post_message', 'slack_message', ref, {
    plannerDraftId: draft.id,
    channel: posted.channel,
  }).catch(() => {})

  return finishHandoff(
    draft.id,
    {
      kind: 'slack',
      ref,
      ...(posted.url ? { url: posted.url } : {}),
      at: new Date().toISOString(),
    },
    { channel: posted.channel, ts: posted.ts, url: posted.url }
  )
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'The planner requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const draft = await prisma.plannerDraft.findFirst({
      where: { id, userId: session.userId, orgId: session.orgId },
    })
    if (!draft) return apiError(404, 'Draft not found')

    const raw = await req.json().catch(() => null)
    const parsed = bodySchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 }
      )
    }
    const data = parsed.data

    // Checked before any rate limit or upstream call.
    if (!draft.body.trim()) return apiError(400, 'Draft body is empty')

    switch (data.kind) {
      case 'email_compose':
        return await handleEmailCompose(session, draft, data)
      case 'email_send':
        return await handleEmailSend(session, draft)
      case 'gdoc':
        return await handleGdoc(session, draft, data)
      case 'card_comment':
        return await handleCardComment(session, draft, data)
      case 'card_create':
        return await handleCardCreate(session, draft, data)
      case 'slack':
        return await handleSlack(session, draft, data)
    }
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/planner/drafts/[id]/handoff error:', err)
    return apiError(500, 'Internal server error')
  }
}
