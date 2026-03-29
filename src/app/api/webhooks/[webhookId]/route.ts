import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/webhooks/[webhookId]
 * Deletes a webhook. The webhook must belong to the session user's organization.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { webhookId: string } }
): Promise<NextResponse> {
  let session
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    return errorResponse as NextResponse
  }

  const { webhookId } = params

  const webhook = await prisma.webhook.findUnique({
    where: { id: webhookId },
  })

  if (!webhook || webhook.orgId !== session.orgId) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  await prisma.webhook.delete({ where: { id: webhookId } })

  return new NextResponse(null, { status: 204 })
}
