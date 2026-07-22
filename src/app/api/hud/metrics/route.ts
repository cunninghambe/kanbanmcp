import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

/**
 * Returns the median of a list of numbers, or null when the list is empty.
 * For an even-length list the average of the two central values is returned.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

// GET /api/hud/metrics — org-scoped §7 quality metrics for the mhud feature.
// Pure reads over AgentDispatch, ChangeSet and ChangeItem. No writes.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')
    const orgId = session.orgId

    const [dispatches, changeSets, changeItems] = await Promise.all([
      prisma.agentDispatch.findMany({
        where: { orgId },
        select: { status: true, startedAt: true, finishedAt: true },
      }),
      prisma.changeSet.findMany({
        where: { orgId },
        select: { status: true, createdAt: true, appliedAt: true },
      }),
      prisma.changeItem.findMany({
        where: { changeSet: { orgId } },
        select: { decision: true },
      }),
    ])

    // ── Dispatch metrics ────────────────────────────────────────────────────
    const byStatus = { done: 0, failed: 0, cancelled: 0, running: 0, queued: 0 }
    const dispatchLatencies: number[] = []
    for (const d of dispatches) {
      if (d.status in byStatus) {
        byStatus[d.status as keyof typeof byStatus]++
      }
      if (d.status === 'done' && d.startedAt && d.finishedAt) {
        dispatchLatencies.push(
          new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()
        )
      }
    }

    // ── ChangeSet metrics ───────────────────────────────────────────────────
    let proposed = 0
    let applied = 0
    let expired = 0
    const reviewTimes: number[] = []
    for (const cs of changeSets) {
      if (cs.status === 'pending' || cs.status === 'partially_applied') proposed++
      if (cs.status === 'applied') applied++
      if (cs.status === 'expired') expired++
      if (cs.status === 'applied' && cs.createdAt && cs.appliedAt) {
        reviewTimes.push(
          new Date(cs.appliedAt).getTime() - new Date(cs.createdAt).getTime()
        )
      }
    }

    // ── ChangeItem decision rates (over decided items) ──────────────────────
    let decided = 0
    let rejected = 0
    let retargeted = 0
    for (const item of changeItems) {
      if (item.decision !== 'pending') {
        decided++
        if (item.decision === 'rejected') rejected++
        if (item.decision === 'retargeted') retargeted++
      }
    }
    const retargetRate = decided === 0 ? 0 : retargeted / decided
    const rejectRate = decided === 0 ? 0 : rejected / decided

    return NextResponse.json({
      dispatch: {
        total: dispatches.length,
        byStatus,
        medianLatencyMs: median(dispatchLatencies),
      },
      changeset: {
        proposed,
        applied,
        expired,
        retargetRate,
        rejectRate,
        medianTimeToReviewMs: median(reviewTimes),
      },
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/hud/metrics error:', err)
    return apiError(500, 'Internal server error')
  }
}
