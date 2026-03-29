import { createHmac } from 'crypto'
import { prisma } from '@/lib/db'
import { assertNotPrivateUrl } from '@/lib/ssrf-guard'

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
    try {
      await assertNotPrivateUrl(wh.url)
    } catch {
      // Skip delivery to internal/invalid URLs
      return
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10_000)

    try {
      const response = await fetch(wh.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-KanbanMCP-Signature': `sha256=${createHmac('sha256', wh.secret).update(body).digest('hex')}`,
        },
        body,
      })

      if (!response.ok) {
        throw new Error(
          `Webhook delivery to ${wh.url} failed with status ${response.status}`
        )
      }
    } finally {
      clearTimeout(timeoutId)
    }
  })

  await Promise.allSettled(deliveries)
}
