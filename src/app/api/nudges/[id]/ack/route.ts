import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { assertInboxOwner, inboxAgentConfig, isValidGmailId } from '@/lib/inbox-agent'

// Fire-and-forget: tell the Apps Script to clear the ai/urgent Gmail label so
// UI state and Gmail state stay consistent. Must never block or fail the ack.
function fireLabelClear(threadId: string): void {
  const config = inboxAgentConfig()
  if (!config) return
  // Stored ids are agent-supplied; refuse to relay anything malformed.
  if (!isValidGmailId(threadId)) return

  fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: config.token, action: 'ack', threadId }),
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    console.warn('nudge ack label-clear callback failed:', err)
  })
}

// POST /api/nudges/[id]/ack — mailbox owner ONLY (API keys and non-owners are
// rejected 403). Acking reaches into the owner's Gmail to clear a label, so it
// carries the same authorization as the rest of the inbox agent.
// Sets status='acked' and fires the Gmail label-clear callback. Idempotent.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'Acking a nudge requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')
    await assertInboxOwner(session)

    const nudge = await prisma.nudge.findFirst({
      where: { id, orgId: session.orgId },
    })
    if (!nudge) return apiError(404, 'Nudge not found')

    // Idempotent: acking an already-acked nudge returns 200 without re-firing.
    if (nudge.status === 'acked') {
      return NextResponse.json({ nudge })
    }

    const updated = await prisma.nudge.update({
      where: { id },
      data: { status: 'acked', ackedById: session.userId, ackedAt: new Date() },
    })

    if (nudge.gmailThreadId) {
      fireLabelClear(nudge.gmailThreadId)
    }

    return NextResponse.json({ nudge: updated })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/nudges/[id]/ack error:', err)
    return apiError(500, 'Internal server error')
  }
}
