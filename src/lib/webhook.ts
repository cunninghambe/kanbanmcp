import { createHmac } from 'crypto'
import { prisma } from '@/lib/db'
import { safeFetch } from '@/lib/ssrf-guard'

/**
 * Dispatches a webhook event to all matching active webhook endpoints
 * registered for the given organization.
 *
 * Each webhook is dispatched concurrently via Promise.allSettled so that
 * a single failing delivery does not block the others.
 */
export async function dispatchWebhook(
  orgId: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  const webhooks = await prisma.webhook.findMany({
    where: { orgId, active: true },
  })

  // Filter to only webhooks that subscribe to this event
  const matching = webhooks.filter((wh) => {
    try {
      const events = JSON.parse(wh.events)
      return Array.isArray(events) && events.includes(event)
    } catch {
      return false
    }
  })

  if (matching.length === 0) return

  const body = JSON.stringify({ event, payload })

  const deliveries = matching.map(async (wh) => {
    // safeFetch internally resolves, validates (rejecting private/internal
    // addresses), and pins the connection — so it is safe even if DNS changed
    // since the webhook was created. It throws on private/invalid URLs, which
    // we treat as a skipped delivery (matching the prior behavior).
    const response = await safeFetch(wh.url, {
      method: 'POST',
      timeoutMs: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'X-KanbanMCP-Signature': `sha256=${createHmac('sha256', wh.secret).update(body).digest('hex')}`,
      },
      body,
    })

    if (!response.ok) {
      throw new Error(`Webhook delivery to ${wh.url} failed with status ${response.status}`)
    }
  })

  await Promise.allSettled(deliveries)
}
