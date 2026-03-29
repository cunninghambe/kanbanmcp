import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'

const updateMemberSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER', 'AGENT_ONLY']),
})

export const dynamic = 'force-dynamic'

// PATCH /api/orgs/[orgId]/members/[userId]
// Updates a member's role. Requires ADMIN role. Admins cannot demote themselves.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { orgId: string; userId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, params.orgId, 'ADMIN')

    // Prevent admins from changing their own role
    if (session.userId === params.userId) {
      return apiError(400, 'You cannot change your own role')
    }

    const body = await req.json()
    const result = updateMemberSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const membership = await prisma.orgMember.findUnique({
      where: { userId_orgId: { userId: params.userId, orgId: params.orgId } },
    })

    if (!membership) {
      return apiError(404, 'Member not found')
    }

    const updated = await prisma.orgMember.update({
      where: { userId_orgId: { userId: params.userId, orgId: params.orgId } },
      data: { role: result.data.role },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    })

    return NextResponse.json({ member: updated })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('PATCH /api/orgs/[orgId]/members/[userId] error:', err)
    return apiError(500, 'Internal server error')
  }
}
