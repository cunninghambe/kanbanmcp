import { NextRequest, NextResponse } from 'next/server'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { hudEnabledTargets } from '@/lib/host-hud/config'

// GET /api/hud/config — deployment config the HUD client needs, chiefly which
// dispatch targets are enabled (HUD_ENABLED_TARGETS). Read-only, session-gated.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')
    return NextResponse.json({ enabledTargets: hudEnabledTargets() })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/hud/config error:', err)
    return apiError(500, 'Internal server error')
  }
}
