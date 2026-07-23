import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { logActivity } from '@/lib/agent-activity'

const bodySchema = z
  .object({
    action: z.enum(['draft', 'send', 'ack']),
    threadId: z.string().optional(),
    instructions: z.string().max(4000, 'instructions too long').optional(),
    replyAll: z.boolean().optional(),
    draftId: z.string().optional(),
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

// POST /api/inbox-agent — server side of the reply loop. Human session ONLY:
// this route can cause an email send, so API keys are hard-rejected like
// ChangeSet apply. The Apps Script token is injected server-side and never
// reaches the browser (the whole point of the proxy). No SSRF surface: the
// target URL comes only from env, never from the request.
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) {
      return apiError(403, 'The inbox agent requires a human session')
    }
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const parsed = bodySchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    const url = process.env.INBOX_AGENT_URL
    const token = process.env.INBOX_AGENT_TOKEN
    if (!url || !token) {
      return apiError(503, 'Inbox agent is not configured')
    }

    const { action, threadId, instructions, replyAll, draftId } = parsed.data

    let upstream: Response
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, action, threadId, instructions, replyAll, draftId }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      console.error('POST /api/inbox-agent upstream error:', err)
      return apiError(502, 'Inbox agent upstream unavailable')
    }

    const data = (await upstream.json()) as Record<string, unknown>

    // Apps Script returns JSON-RPC-style failures in-band as { error }.
    if (data && typeof data === 'object' && 'error' in data && data.error) {
      return NextResponse.json({ error: data.error }, { status: 502 })
    }

    // Provenance for every outbound email (send at minimum).
    if (action === 'send') {
      logActivity(session.orgId, 'inbox-agent', action, 'gmail_thread', threadId ?? draftId ?? '', {
        draftId: draftId ?? null,
        threadId: threadId ?? null,
      }).catch(() => {})
    }

    return NextResponse.json(data)
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/inbox-agent error:', err)
    return apiError(500, 'Internal server error')
  }
}
