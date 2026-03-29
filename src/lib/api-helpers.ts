import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sessionOptions, SessionData } from '@/lib/session'
import type { OrgMember } from '@prisma/client'

// Role hierarchy: lower number = less privilege
const ROLE_RANK: Record<string, number> = {
  AGENT_ONLY: 0,
  MEMBER: 1,
  ADMIN: 2,
}

/**
 * Reads the iron-session cookie and returns session data.
 * Throws a 401 Response if the session has no userId (not logged in).
 */
export async function requireSession(req: Request): Promise<SessionData> {
  const session = await getIronSession<SessionData>(cookies(), sessionOptions)
  if (!session.userId) {
    throw NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return { userId: session.userId, orgId: session.orgId }
}

/**
 * Verifies that the session user is a member of the given org with at least
 * the required role. Throws a 403 Response if not.
 */
export async function requireOrgRole(
  session: SessionData,
  orgId: string,
  minRole: 'MEMBER' | 'ADMIN'
): Promise<OrgMember> {
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
