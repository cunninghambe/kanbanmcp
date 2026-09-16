// POST /api/planner/drafts/[id]/generate — "ask claude" (spec §5.6).
//
// The second and last attended model call. The model's text replaces the body
// verbatim (no JSON parsing, nothing executed) and clears `pendingEmail`, so a
// generated body can never be sent as a previously composed one.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiError, requireOrgRole, requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import { checkRateLimit } from '@/lib/rate-limit'
import {
  PlannerLlmUnconfiguredError,
  buildDraftPrompt,
  runPlannerCompletion,
} from '@/lib/planner/llm'
import { DRAFT_MODES, toPlannerDraftDTO, toPlannerItemDTO } from '@/lib/planner/types'
import type { PlannerItemDTO } from '@/lib/planner/types'

const bodySchema = z.object({
  instructions: z.string().min(1).max(4000),
  mode: z.enum(DRAFT_MODES),
  currentBody: z.string().max(50_000).optional(),
})

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'The planner requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const raw = await req.json().catch(() => null)
    const parsed = bodySchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 }
      )
    }
    const { instructions, mode, currentBody } = parsed.data

    const draft = await prisma.plannerDraft.findFirst({
      where: { id, userId: session.userId, orgId: session.orgId },
    })
    if (!draft) return apiError(404, 'Draft not found')

    if (!checkRateLimit(`planner-generate:${session.userId}`, 10, 10 * 60_000)) {
      return apiError(429, 'Ask claude is limited to 10 runs per 10 minutes')
    }

    const previousBody = currentBody ?? draft.body

    let item: PlannerItemDTO | null = null
    if (draft.itemId) {
      const row = await prisma.plannerItem.findFirst({
        where: { id: draft.itemId, userId: session.userId, orgId: session.orgId },
      })
      item = row ? toPlannerItemDTO(row) : null
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { name: true, email: true },
    })
    const userName = user?.name?.trim() || user?.email || 'you'

    const prompt = buildDraftPrompt({
      mode,
      instructions,
      title: draft.title,
      currentBody: previousBody,
      item,
      userName,
    })

    let completion
    try {
      completion = await runPlannerCompletion({
        system: prompt.system,
        user: prompt.user,
        maxTokens: 2000,
        orgId: session.orgId,
      })
    } catch (err) {
      if (err instanceof PlannerLlmUnconfiguredError) {
        return apiError(503, 'No AI backend configured')
      }
      console.error('POST /api/planner/drafts/[id]/generate model call failed:', err)
      return apiError(502, 'Draft generation failed')
    }

    const updated = await prisma.plannerDraft.update({
      where: { id },
      data: { body: completion.text, pendingEmail: null },
    })

    return NextResponse.json({
      draft: toPlannerDraftDTO(updated),
      previousBody,
      model: completion.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/planner/drafts/[id]/generate error:', err)
    return apiError(500, 'Internal server error')
  }
}
