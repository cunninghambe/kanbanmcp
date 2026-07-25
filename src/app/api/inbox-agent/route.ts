import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession, apiError } from '@/lib/api-helpers'
import { logActivity } from '@/lib/agent-activity'
import { checkRateLimit } from '@/lib/rate-limit'
import { assertInboxOwner, inboxAgentConfig, GMAIL_ID_PATTERN } from '@/lib/inbox-agent'

const gmailId = z.string().regex(GMAIL_ID_PATTERN, 'malformed Gmail id')

const bodySchema = z
  .object({
    action: z.enum(['draft', 'send', 'ack']),
    threadId: gmailId.optional(),
    instructions: z.string().max(4000, 'instructions too long').optional(),
    replyAll: z.boolean().optional(),
    draftId: gmailId.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.action === 'draft') {
      if (!val.threadId)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'threadId is required for draft', path: ['threadId'] })
      if (!val.instructions)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'instructions is required for draft', path: ['instructions'] })
    }
    if (val.action === 'send' && !val.draftId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'draftId is required for send', path: ['draftId'] })
    }
    if (val.action === 'ack' && !val.threadId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'threadId is required for ack', path: ['threadId'] })
    }
  })

// Each draft burns Anthropic tokens upstream and each send is irreversible, so
// cap both well below anything a human does by hand.
const RATE_LIMIT = 20
const RATE_WINDOW_MS = 5 * 60_000

// POST /api/inbox-agent — server side of the reply loop.
//
// AUTHORIZATION: mailbox-owner only (see lib/inbox-agent.ts). Org membership is
// deliberately NOT the control here: this route targets one specific person's
// Gmail via deployment-wide env, so an org-membership check would authorize
// every registered user on the instance to read that mailbox and send mail as
// its owner. API-key sessions are rejected outright — a send is always a human
// act, exactly like ChangeSet apply.
//
// The Apps Script token is injected server-side and never reaches the browser
// (the whole point of the proxy). No SSRF surface: the target URL comes only
// from env, never from the request.
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) {
      return apiError(403, 'The inbox agent requires a human session')
    }
    await assertInboxOwner(session)

    const parsed = bodySchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    const config = inboxAgentConfig()
    if (!config) {
      return apiError(503, 'Inbox agent is not configured')
    }

    const { action, threadId, instructions, replyAll, draftId } = parsed.data

    if (!process.env.PLAYWRIGHT_E2E) {
      if (!checkRateLimit(`inbox-agent:${session.userId}`, RATE_LIMIT, RATE_WINDOW_MS)) {
        return apiError(429, 'Too many inbox-agent requests, slow down')
      }
    }

    let upstream: Response
    try {
      upstream = await fetch(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: config.token, action, threadId, instructions, replyAll, draftId }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      console.error('POST /api/inbox-agent upstream error:', err)
      return apiError(502, 'Inbox agent upstream unavailable')
    }

    const data = (await upstream.json()) as Record<string, unknown>

    // Apps Script returns JSON-RPC-style failures in-band as { error }. Log the
    // detail server-side but return a fixed message: upstream strings can carry
    // thread/draft ids and Anthropic account state, which would turn this route
    // into an existence oracle for the mailbox.
    if (data && typeof data === 'object' && 'error' in data && data.error) {
      console.error('POST /api/inbox-agent upstream reported:', data.error)
      return apiError(502, 'Inbox agent request failed')
    }

    // Provenance for EVERY mailbox action, not just sends: a draft reads a
    // thread, an ack mutates Gmail labels. All three belong in the audit trail.
    logActivity(session.orgId, 'inbox-agent', action, 'gmail_thread', threadId ?? draftId ?? '', {
      draftId: draftId ?? null,
      threadId: threadId ?? null,
      byUserId: session.userId,
    }).catch(() => {})

    return NextResponse.json(data)
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/inbox-agent error:', err)
    return apiError(500, 'Internal server error')
  }
}
