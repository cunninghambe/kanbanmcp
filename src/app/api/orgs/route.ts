import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'

// GET /api/orgs
// Returns all organizations where the current user is a member, with member count.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req)

    const memberships = await prisma.orgMember.findMany({
      where: { userId: session.userId },
      include: {
        org: {
          include: {
            _count: {
              select: { members: true },
            },
          },
        },
      },
    })

    const orgs = memberships.map((m) => ({
      ...m.org,
      memberCount: m.org._count.members,
      userRole: m.role,
    }))

    return NextResponse.json({ orgs })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/orgs error:', err)
    return apiError(500, 'Internal server error')
  }
}
