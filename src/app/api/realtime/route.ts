import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import type { SessionData } from '@/lib/session'

export const dynamic = 'force-dynamic'

const POLL_INTERVAL_MS = 2000

/**
 * GET /api/realtime?boardId=<id>
 *
 * Server-Sent Events endpoint for real-time board updates.
 * Polls the database every 2 seconds for card changes since the last check.
 * Emits `card_created`, `card_updated`, and `card_moved` events in SSE format.
 *
 * Requires session authentication. Board must belong to the authenticated user's org.
 */
export async function GET(req: NextRequest): Promise<Response> {
  // Authenticate — if this throws, it's a NextResponse (not a plain Response)
  let session: SessionData
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    // Cast to Response — NextResponse extends Response
    return errorResponse as Response
  }

  const { searchParams } = new URL(req.url)
  const boardId = searchParams.get('boardId')

  if (!boardId) {
    return new Response(
      JSON.stringify({ error: 'boardId query parameter is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Validate that the board belongs to the user's org before creating the stream
  const board = await prisma.board.findFirst({
    where: { id: boardId, orgId: session.orgId },
    select: { id: true },
  })
  if (!board) {
    return NextResponse.json({ error: 'Board not found' }, { status: 404 }) as Response
  }

  // Pre-fetch current card positions so we can detect moves on first update
  const initialCards = await prisma.card.findMany({
    where: { boardId, board: { orgId: session.orgId } },
    select: { id: true, columnId: true, position: true },
  })
  const cardPositionCache = new Map<string, { columnId: string; position: number }>(
    (initialCards as { id: string; columnId: string; position: number }[]).map(
      (c): [string, { columnId: string; position: number }] => [
        c.id,
        { columnId: c.columnId, position: c.position },
      ]
    )
  )

  const stream = new ReadableStream({
    start(controller) {
      let checkFrom = new Date()
      let closed = false

      const encoder = new TextEncoder()

      // Send an initial heartbeat so the client knows the connection is live
      controller.enqueue(encoder.encode(': heartbeat\n\n'))

      async function poll() {
        if (closed) return
        try {
          const now = new Date()
          const changedCards = await prisma.card.findMany({
            where: {
              boardId,
              board: { orgId: session.orgId },
              updatedAt: { gt: checkFrom },
            },
            select: {
              id: true,
              title: true,
              columnId: true,
              position: true,
              createdAt: true,
              updatedAt: true,
            },
            orderBy: { updatedAt: 'asc' },
          })
          checkFrom = now

          for (const card of changedCards) {
            const diffMs = card.updatedAt.getTime() - card.createdAt.getTime()
            const isNew = diffMs < 1000

            let eventType: string
            if (isNew) {
              eventType = 'card_created'
              cardPositionCache.set(card.id, { columnId: card.columnId, position: card.position })
            } else {
              const prev = cardPositionCache.get(card.id)
              if (prev && (prev.columnId !== card.columnId || prev.position !== card.position)) {
                eventType = 'card_moved'
              } else {
                eventType = 'card_updated'
              }
              cardPositionCache.set(card.id, { columnId: card.columnId, position: card.position })
            }

            const message = `event: ${eventType}\ndata: ${JSON.stringify({ cardId: card.id, columnId: card.columnId, position: card.position, updatedAt: card.updatedAt })}\n\n`
            controller.enqueue(encoder.encode(message))
          }
        } catch (_e) {
          closed = true
          try { controller.close() } catch {}
          return
        }
        if (!closed) {
          setTimeout(poll, POLL_INTERVAL_MS)
        }
      }

      // Begin polling after the first interval
      const initialTimer = setTimeout(poll, POLL_INTERVAL_MS)

      // Clean up when the client disconnects
      req.signal.addEventListener('abort', () => {
        closed = true
        clearTimeout(initialTimer)
        try {
          controller.close()
        } catch {
          // Already closed
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable Nginx buffering when behind a proxy
    },
  })
}
