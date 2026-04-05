import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sessionOptions, SessionData } from '@/lib/session'
import { requireApiKey } from '@/lib/agent-auth'
import type { OrgMember } from '@prisma/client'

// Role hierarchy: lower number = less privilege
const ROLE_RANK: Record<string, number> = {
  AGENT_ONLY: 0,
  MEMBER: 1,
  ADMIN: 2,
}

/**
 * Authenticates the request via either:
 *   1. Bearer API key (Authorization: Bearer <key>) — checked first, or
 *   2. iron-session cookie — used as fallback.
 *
 * Throws a 401 Response if neither authentication method succeeds.
 * Returns a SessionData object; when authenticated via API key,
 * isApiKeyAuth is true and agentName is populated.
 */
export async function requireSession(req: Request): Promise<SessionData> {
  // Check for Bearer token first
  const authHeader = (req as NextRequest).headers?.get?.('authorization') ?? null
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Will throw a 401 NextResponse if invalid
    const agentCtx = await requireApiKey(req as NextRequest)
    return {
      userId: '',       // No real userId for API key auth
      orgId: agentCtx.orgId,
      isApiKeyAuth: true,
      agentName: agentCtx.agentName,
    }
  }

  // Fall back to cookie-based session auth
  const session = await getIronSession<SessionData>(cookies(), sessionOptions)
  if (!session.userId) {
    throw NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return { userId: session.userId, orgId: session.orgId }
}

/**
 * Verifies that the session user is a member of the given org with at least
 * the required role. Throws a 403 Response if not.
 *
 * When the session is from API key auth (isApiKeyAuth=true), the org membership
 * check is skipped — the API key already encodes the orgId scope, so we only
 * verify that the requested orgId matches the key's orgId.
 */
export async function requireOrgRole(
  session: SessionData,
  orgId: string,
  minRole: 'MEMBER' | 'ADMIN'
): Promise<OrgMember | null> {
  // API key auth: skip user membership lookup, just confirm orgId matches
  if (session.isApiKeyAuth) {
    if (session.orgId !== orgId) {
      throw NextResponse.json(
        { error: 'Forbidden: API key does not belong to this organization' },
        { status: 403 }
      )
    }
    // Return null — callers that need a real OrgMember should handle this case
    return null
  }

  const membership = await prisma.orgMember.findUnique({
    where: {
      userId_orgId: {
        userId: session.userId,
        orgId,
      },
    },
  })

  if (!membership) {
    throw NextResponse.json(
      { error: 'Forbidden: not a member of this organization' },
      { status: 403 }
    )
  }

  const userRank = ROLE_RANK[membership.role] ?? -1
  const requiredRank = ROLE_RANK[minRole] ?? 999

  if (userRank < requiredRank) {
    throw NextResponse.json(
      { error: 'Forbidden: insufficient role' },
      { status: 403 }
    )
  }

  return membership
}

/**
 * Returns a standardised JSON error response.
 */
export function apiError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

/**
 * Parses `page` and `limit` query parameters from a URL string.
 * Defaults: page=1, limit=20. Maximum limit=100.
 */
export function paginationParams(url: string): {
  page: number
  limit: number
  skip: number
} {
  const { searchParams } = new URL(url)

  let page = parseInt(searchParams.get('page') ?? '1', 10)
  let limit = parseInt(searchParams.get('limit') ?? '20', 10)

  if (isNaN(page) || page < 1) page = 1
  if (isNaN(limit) || limit < 1) limit = 20
  if (limit > 100) limit = 100

  const skip = (page - 1) * limit

  return { page, limit, skip }
}
