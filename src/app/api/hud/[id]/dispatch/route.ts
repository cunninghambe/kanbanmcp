import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { enqueueDispatch } from '@/lib/host-hud/worker'
import { DISPATCH_TARGETS } from '@/lib/host-hud/dispatch'
import {
  MAX_QUESTION_LENGTH,
  isTargetEnabled,
  maxInflightPerSession,
  maxInflightPerOrg,
} from '@/lib/host-hud/config'

const dispatchSchema = z.object({
  target: z.enum(DISPATCH_TARGETS),
  question: z
    .string()
    .min(1, 'question is required')
    .max(MAX_QUESTION_LENGTH, `question must be at most ${MAX_QUESTION_LENGTH} characters`),
})

const IN_FLIGHT = ['queued', 'running']

// GET /api/hud/[id]/dispatch — list this session's dispatches.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const hud = await prisma.hudSession.findFirst({
      where: { id, orgId: session.orgId },
      select: { id: true },
    })
    if (!hud) return apiError(404, 'HUD session not found')

    const dispatches = await prisma.agentDispatch.findMany({
      where: { hudSessionId: id },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({
      dispatches: dispatches.map((d) => ({
        ...d,
        citations: d.citations ? safeParse(d.citations) : null,
      })),
    })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/hud/[id]/dispatch error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/hud/[id]/dispatch — fire a read-only agent query. Human session only.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'Dispatching an agent requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const hud = await prisma.hudSession.findFirst({
      where: { id, orgId: session.orgId },
      select: { id: true, status: true },
    })
    if (!hud) return apiError(404, 'HUD session not found')
    if (hud.status !== 'live') return apiError(409, 'HUD session is not live')

    const parsed = dispatchSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    // Capability gate: reject a target this deployment has not enabled, so the
    // chair gets a clear error instead of a confusing mid-meeting agent failure.
    if (!isTargetEnabled(parsed.data.target)) {
      return apiError(400, `Target "${parsed.data.target}" is not enabled for this deployment`)
    }

    // Concurrency caps: each dispatch is a real, paid external ClaudeMCP job.
    // Best-effort (non-transactional) count — a small transient overshoot under
    // concurrent POSTs is acceptable for a single-chair HUD.
    const [sessionInFlight, orgInFlight] = await Promise.all([
      prisma.agentDispatch.count({ where: { hudSessionId: id, status: { in: IN_FLIGHT } } }),
      prisma.agentDispatch.count({ where: { orgId: session.orgId, status: { in: IN_FLIGHT } } }),
    ])
    if (sessionInFlight >= maxInflightPerSession()) {
      return apiError(429, `This session already has ${sessionInFlight} agents in flight (max ${maxInflightPerSession()})`)
    }
    if (orgInFlight >= maxInflightPerOrg()) {
      return apiError(429, `Your organization already has ${orgInFlight} agents in flight (max ${maxInflightPerOrg()})`)
    }

    const dispatch = await prisma.agentDispatch.create({
      data: {
        orgId: session.orgId,
        hudSessionId: id,
        chairId: session.userId,
        target: parsed.data.target,
        question: parsed.data.question,
        status: 'queued',
      },
    })

    enqueueDispatch(dispatch.id)

    return NextResponse.json({ dispatch }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/hud/[id]/dispatch error:', err)
    return apiError(500, 'Internal server error')
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
