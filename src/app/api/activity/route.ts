import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/activity
 * Returns paginated agent activity logs for the session user's organization.
 *
 * Query parameters:
 *   agentName  — optional filter by agent name
 *   page       — 1-indexed page number (default: 1)
 *   limit      — records per page (default: 20, max: 100)
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  let session
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    return errorResponse as NextResponse
  }

  const { searchParams } = new URL(req.url)

  const agentNameFilter = searchParams.get('agentName') ?? undefined

  let page = parseInt(searchParams.get('page') ?? '1', 10)
  let limit = parseInt(searchParams.get('limit') ?? '20', 10)

  if (isNaN(page) || page < 1) page = 1
  if (isNaN(limit) || limit < 1) limit = 20
  if (limit > 100) limit = 100

  const skip = (page - 1) * limit

  const where = {
    orgId: session.orgId,
    ...(agentNameFilter ? { agentName: agentNameFilter } : {}),
  }

  type ActivityRow = {
    id: string
    orgId: string
    agentName: string
    action: string
    resourceType: string
    resourceId: string | null
    metadata: string
    createdAt: Date
  }

  const rawActivities: ActivityRow[] = await prisma.agentActivity.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip,
  })
  const total: number = await prisma.agentActivity.count({ where })

  const activities = rawActivities.map((activity) => ({
    ...activity,
    metadata: (() => {
      try {
        return JSON.parse(activity.metadata)
      } catch {
        return activity.metadata
      }
    })(),
  }))

  return NextResponse.json({ activities, total, page, limit })
}
