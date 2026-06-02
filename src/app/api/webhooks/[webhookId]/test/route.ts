import { NextRequest, NextResponse } from 'next/server'
import { createHmac } from 'crypto'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'
import { assertNotPrivateUrl, safeFetch } from '@/lib/ssrf-guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/webhooks/[webhookId]/test
 * Sends a signed test ping to the webhook URL from the server.
 * Requires session authentication and org membership.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ webhookId: string }> }
): Promise<NextResponse> {
  const params = await ctx.params
  let session
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    return errorResponse as NextResponse
  }

  const webhook = await prisma.webhook.findUnique({
    where: { id: params.webhookId },
  })

  if (!webhook || webhook.orgId !== session.orgId) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  try {
    await assertNotPrivateUrl(webhook.url)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid URL'
    return apiError(422, message)
  }

  const body = JSON.stringify({
    event: 'ping',
    payload: { test: true, webhookId: webhook.id, sentAt: new Date().toISOString() },
  })

  const signature = `sha256=${createHmac('sha256', webhook.secret).update(body).digest('hex')}`

  try {
    // safeFetch re-resolves + re-validates + pins the connection (defeating
    // DNS-rebinding TOCTOU) and does not follow redirects.
    const response = await safeFetch(webhook.url, {
      method: 'POST',
      timeoutMs: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'X-KanbanMCP-Signature': signature,
      },
      body,
    })

    return NextResponse.json({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Request failed'
    return apiError(502, `Test ping failed: ${message}`)
  }
}
