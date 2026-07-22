import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { enqueueDispatch } from '@/lib/host-hud/worker'
import { DISPATCH_TARGETS } from '@/lib/host-hud/dispatch'
import { checkRateLimit } from '@/lib/rate-limit'

const dispatchSchema = z.object({
  target: z.enum(DISPATCH_TARGETS),
  question: z.string().min(1, 'question is required'),
})

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

    // Rate limit: 20 dispatches per user per 60s to stop a chair (or a loop)
    // from flooding ClaudeMCP. Skipped during Playwright e2e so suites are not blocked.
    if (!process.env.PLAYWRIGHT_E2E) {
      const rateKey = `hud-dispatch:${session.userId ?? id}`
      if (!checkRateLimit(rateKey, 20, 60_000)) {
        return apiError(429, 'Too many dispatches, slow down')
      }
    }

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
