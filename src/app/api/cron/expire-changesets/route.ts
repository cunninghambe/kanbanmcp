import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { expireStaleChangeSets } from '@/lib/changesets'

// POST /api/cron/expire-changesets
// Flips stale pending/partially_applied ChangeSets past their expiresAt to
// `expired`. Requires Authorization: Bearer <CRON_SECRET>.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const expired = await expireStaleChangeSets(prisma)

  return NextResponse.json({ expired })
}
