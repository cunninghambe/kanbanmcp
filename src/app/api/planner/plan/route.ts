// POST /api/planner/plan — "plan my day" (spec §5.5).
//
// One of the only two model calls in the planner, and it happens because a
// human clicked: no cron, no worker, no collector reaches a model (§1.4(4)).

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiError, requireOrgRole, requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import { checkRateLimit } from '@/lib/rate-limit'
import {
  PlannerLlmUnconfiguredError,
  buildPlanPrompt,
  parsePlanResponse,
  runPlannerCompletion,
} from '@/lib/planner/llm'
import {
  buildTodayResponse,
  ensureCollected,
  plannerDateSchema,
  plannerTzSchema,
} from '@/lib/planner/service'
import type { RankedItemDTO } from '@/lib/planner/types'

const bodySchema = z.object({ date: plannerDateSchema, tz: plannerTzSchema })

const MAX_TASK_ITEMS = 12
const PLAN_SECTIONS = new Set(['now', 'today', 'soon'])

function isMeeting(item: RankedItemDTO, window: { start: string; end: string }): boolean {
  if (item.source !== 'calendar' || item.status !== 'open') return false
  if (!item.startsAt || !item.endsAt) return false
  return item.startsAt < window.end && item.endsAt > window.start
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'The planner requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json().catch(() => null)
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 }
      )
    }
    const { date, tz } = parsed.data

    if (!checkRateLimit(`planner-plan:${session.userId}`, 3, 10 * 60_000)) {
      return apiError(429, 'Plan my day is limited to 3 runs per 10 minutes')
    }

    const now = new Date()
    const { day } = await ensureCollected(prisma, {
      userId: session.userId,
      orgId: session.orgId,
      date,
      tz,
      force: false,
      now,
    })
    const today = await buildTodayResponse(prisma, {
      userId: session.userId,
      orgId: session.orgId,
      date,
      tz,
      now,
      day,
    })

    const tasks = today.items
      .filter(
        (item) =>
          item.status === 'open' && item.source !== 'calendar' && PLAN_SECTIONS.has(item.section)
      )
      .slice(0, MAX_TASK_ITEMS)
    const meetings = today.items.filter((item) => isMeeting(item, today.window))

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { name: true, email: true },
    })
    const userName = user?.name?.trim() || user?.email || 'you'

    const prompt = buildPlanPrompt({ userName, date, tz, items: tasks, meetings })
    let completion
    try {
      completion = await runPlannerCompletion({
        system: prompt.system,
        user: prompt.user,
        maxTokens: 1500,
        orgId: session.orgId,
      })
    } catch (err) {
      if (err instanceof PlannerLlmUnconfiguredError) {
        return apiError(503, 'No AI backend configured')
      }
      console.error('POST /api/planner/plan model call failed:', err)
      return apiError(502, 'Plan generation failed')
    }

    const plan = parsePlanResponse(completion.text)

    // `updateMany` with the owner in the `where` is the IDOR guard: an id the
    // model invented (or borrowed) simply updates nothing.
    let updatedItems = 0
    for (const entry of plan.items) {
      const res = await prisma.plannerItem.updateMany({
        where: { id: entry.id, userId: session.userId },
        data: { prepNotes: entry.prepNotes },
      })
      updatedItems += res.count
    }

    await prisma.plannerDay.update({
      where: { id: day.id },
      data: { brief: plan.brief, briefModel: completion.model, briefAt: now },
    })

    return NextResponse.json({
      brief: plan.brief,
      model: completion.model,
      updatedItems,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/planner/plan error:', err)
    return apiError(500, 'Internal server error')
  }
}
