import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

// GET /api/orgs/[orgId]
// Returns the organization with its members. Requires org membership.
export async function GET(
  req: NextRequest,
  { params }: { params: { orgId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, params.orgId, 'MEMBER')

    const org = await prisma.organization.findUnique({
      where: { id: params.orgId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                createdAt: true,
              },
            },
          },
        },
        _count: {
          select: { members: true, boards: true },
        },
      },
    })

    if (!org) {
      return apiError(404, 'Organization not found')
    }

    return NextResponse.json({ org })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/orgs/[orgId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
