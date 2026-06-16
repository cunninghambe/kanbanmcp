import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { applyChangeSet } from '@/lib/changesets'
import { logActivity } from '@/lib/agent-activity'

const applySchema = z.object({
  approvedItemIds: z.array(z.string()).optional(),
})

// POST /api/changesets/[id]/apply — transactionally apply approved items.
// HUMAN SESSION ONLY (MEETINGCOPILOTSPEC §4.5). Every applied item writes
// AgentActivity provenance pointing back at the ChangeSet.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) {
      return apiError(403, 'Applying changes requires a human session; agents may only propose')
    }
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const body = await req.json().catch(() => ({}))
    const parsed = applySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    const result = await applyChangeSet(prisma, id, {
      orgId: session.orgId,
      userId: session.userId,
      approvedItemIds: parsed.data.approvedItemIds,
    })

    if (!result.ok) {
      if (result.reason === 'not_found') return apiError(404, 'ChangeSet not found')
      if (result.reason === 'already_applied') return apiError(409, 'ChangeSet already applied')
      return apiError(400, 'Could not apply ChangeSet')
    }

    for (const applied of result.applied) {
      logActivity(session.orgId, 'Host Meeting HUD', `apply_${applied.op}`, applied.resourceType, applied.resourceId, {
        changeSetId: id,
        itemId: applied.itemId,
        approvedById: session.userId,
      }).catch(() => {})
    }

    return NextResponse.json({ status: result.status, applied: result.applied, failures: result.failures })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/changesets/[id]/apply error:', err)
    return apiError(500, 'Internal server error')
  }
}
