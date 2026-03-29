import { NextRequest, NextResponse } from 'next/server'
import { createHmac } from 'crypto'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'
import { assertNotPrivateUrl } from '@/lib/ssrf-guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/webhooks/[webhookId]/test
 * Sends a signed test ping to the webhook URL from the server.
 * Requires session authentication and org membership.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { webhookId: string } }
): Promise<NextResponse> {
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

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-KanbanMCP-Signature': signature,
      },
      body,
    })
    clearTimeout(timeoutId)

    return NextResponse.json({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    })
  } catch (err) {
    clearTimeout(timeoutId)
    const message = err instanceof Error ? err.message : 'Request failed'
    return apiError(502, `Test ping failed: ${message}`)
  }
}
