// GET /api/planner/today — spec §5.1.
//
// Human sessions only, per-user, and the only thing in the app that triggers a
// collection: there is no cron and no worker (§1.4(4)).

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiError, requireOrgRole, requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import { checkRateLimit } from '@/lib/rate-limit'
import {
  buildTodayResponse,
  ensureCollected,
  plannerDateSchema,
  plannerTzSchema,
} from '@/lib/planner/service'

const querySchema = z.object({
  date: plannerDateSchema,
  tz: plannerTzSchema,
  refresh: z.string().optional(),
})

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'The planner requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const { searchParams } = new URL(req.url)
    const parsed = querySchema.safeParse({
      date: searchParams.get('date') ?? undefined,
      tz: searchParams.get('tz') ?? undefined,
      refresh: searchParams.get('refresh') ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 }
      )
    }
    const { date, tz } = parsed.data
    const force = parsed.data.refresh === '1'

    // Only the forced path is limited; polling the cached payload is free.
    if (force && !checkRateLimit(`planner-refresh:${session.userId}`, 6, 60_000)) {
      return apiError(429, 'Too many refreshes. Try again in a minute.')
    }

    const now = new Date()
    const { day } = await ensureCollected(prisma, {
      userId: session.userId,
      orgId: session.orgId,
      date,
      tz,
      force,
      now,
    })
    const body = await buildTodayResponse(prisma, {
      userId: session.userId,
      orgId: session.orgId,
      date,
      tz,
      now,
      day,
    })
    return NextResponse.json(body)
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/planner/today error:', err)
    return apiError(500, 'Internal server error')
  }
}
