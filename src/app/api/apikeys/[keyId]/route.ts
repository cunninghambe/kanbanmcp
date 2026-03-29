import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/apikeys/[keyId]
 * Deletes an API key. The key must belong to the session user's organization.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { keyId: string } }
): Promise<NextResponse> {
  let session
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    return errorResponse as NextResponse
  }

  const { keyId } = params

  // Verify the key belongs to this org before deleting
  const apiKey = await prisma.apiKey.findUnique({
    where: { id: keyId },
  })

  if (!apiKey || apiKey.orgId !== session.orgId) {
    return NextResponse.json({ error: 'API key not found' }, { status: 404 })
  }

  await prisma.apiKey.delete({ where: { id: keyId } })

  return new NextResponse(null, { status: 204 })
}
