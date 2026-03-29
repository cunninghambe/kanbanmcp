import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/api-helpers'
import { assertNotPrivateUrl } from '@/lib/ssrf-guard'

export const dynamic = 'force-dynamic'

const ALLOWED_EVENTS = [
  'card.created',
  'card.updated',
  'card.moved',
  'sprint.started',
  'sprint.completed',
] as const

const createWebhookSchema = z.object({
  url: z.string().url('url must be a valid URL'),
  events: z
    .array(z.string())
    .min(1, 'At least one event is required')
    .refine(
      (evts) => evts.every((e) => (ALLOWED_EVENTS as readonly string[]).includes(e)),
      {
        message: `events must be one of: ${ALLOWED_EVENTS.join(', ')}`,
      }
    ),
  secret: z.string().min(1, 'secret is required'),
})

/**
 * GET /api/webhooks
 * Returns all webhooks registered for the session user's organization.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  let session
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    return errorResponse as NextResponse
  }

  const webhooks = await prisma.webhook.findMany({
    where: { orgId: session.orgId },
    orderBy: { createdAt: 'desc' },
  })

  const parsed = webhooks.map(({ events, secret: _secret, ...rest }) => ({
    ...rest,
    events: (() => {
      try {
        const parsed = JSON.parse(events)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })(),
  }))

  return NextResponse.json(parsed)
}

/**
 * POST /api/webhooks
 * Registers a new webhook for the session user's organization.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let session
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    return errorResponse as NextResponse
  }

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = createWebhookSchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation error', details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const { url, events, secret } = parsed.data

  try {
    await assertNotPrivateUrl(url)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid URL'
    return NextResponse.json({ error: message }, { status: 422 })
  }

  const webhook = await prisma.webhook.create({
    data: {
      orgId: session.orgId,
      url,
      events: JSON.stringify(events),
      secret,
      active: true,
    },
  })

  return NextResponse.json(
    {
      id: webhook.id,
      orgId: webhook.orgId,
      url: webhook.url,
      active: webhook.active,
      createdAt: webhook.createdAt,
      events,
    },
    { status: 201 }
  )
}
