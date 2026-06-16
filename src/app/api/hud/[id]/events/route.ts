import { NextRequest, NextResponse } from 'next/server'
import { requireSession, apiError } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import type { SessionData } from '@/lib/session'

export const dynamic = 'force-dynamic'

const POLL_INTERVAL_MS = 2000

/**
 * GET /api/hud/[id]/events
 *
 * Server-Sent Events stream for a HUD session. Polls the session's dispatches
 * every 2s and emits a `dispatch_updated` event whenever any dispatch's status
 * or completion changes (the client revalidates its SWR cache on each event).
 * Reuses the SSE-over-polling transport from /api/realtime.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params

  let session: SessionData
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    return errorResponse as Response
  }

  const hud = await prisma.hudSession.findFirst({
    where: { id, orgId: session.orgId },
    select: { id: true },
  })
  if (!hud) return apiError(404, 'HUD session not found') as Response

  async function signature(): Promise<string> {
    const rows = await prisma.agentDispatch.findMany({
      where: { hudSessionId: id },
      select: { id: true, status: true, finishedAt: true, proposedChangeSetId: true },
      orderBy: { createdAt: 'asc' },
    })
    return JSON.stringify(
      rows.map((r) => [r.id, r.status, r.finishedAt?.getTime() ?? 0, r.proposedChangeSetId ?? ''])
    )
  }

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const encoder = new TextEncoder()
      let last = await signature()

      controller.enqueue(encoder.encode(': heartbeat\n\n'))

      async function poll() {
        if (closed) return
        try {
          const next = await signature()
          if (next !== last) {
            last = next
            controller.enqueue(encoder.encode(`event: dispatch_updated\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`))
          } else {
            // keep the connection warm through proxies
            controller.enqueue(encoder.encode(': heartbeat\n\n'))
          }
        } catch {
          closed = true
          try {
            controller.close()
          } catch {}
          return
        }
        if (!closed) setTimeout(poll, POLL_INTERVAL_MS)
      }

      const timer = setTimeout(poll, POLL_INTERVAL_MS)

      req.signal.addEventListener('abort', () => {
        closed = true
        clearTimeout(timer)
        try {
          controller.close()
        } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
