import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { hashPassword } from '@/lib/auth'
import { nanoid } from 'nanoid'

const inviteMemberSchema = z.object({
  email: z.string().email('Invalid email address'),
  name: z.string().min(1).optional(),
  role: z.enum(['MEMBER', 'ADMIN', 'AGENT_ONLY']).optional().default('MEMBER'),
})

// GET /api/orgs/[orgId]/members
// Returns all members with user details. Requires org membership.
export async function GET(
  req: NextRequest,
  { params }: { params: { orgId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, params.orgId, 'MEMBER')

    const members = await prisma.orgMember.findMany({
      where: { orgId: params.orgId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            isAgent: true,
            createdAt: true,
          },
        },
      },
      orderBy: { user: { name: 'asc' } },
    })

    return NextResponse.json({ members })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/orgs/[orgId]/members error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/orgs/[orgId]/members
// Invite a user to the org. Requires ADMIN role.
// If user with email exists: create OrgMember if not already a member.
// If user doesn't exist: create User with random passwordHash + OrgMember.
export async function POST(
  req: NextRequest,
  { params }: { params: { orgId: string } }
) {
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, params.orgId, 'ADMIN')

    const body = await req.json()
    const result = inviteMemberSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { email, name, role } = result.data

    // Verify org exists
    const org = await prisma.organization.findUnique({
      where: { id: params.orgId },
    })
    if (!org) {
      return apiError(404, 'Organization not found')
    }

    let user = await prisma.user.findUnique({ where: { email } })

    if (!user) {
      // Create new user with a random password hash (they must reset it)
      const randomPassword = nanoid(32)
      const passwordHash = await hashPassword(randomPassword)
      user = await prisma.user.create({
        data: {
          email,
          name: name ?? email.split('@')[0],
          passwordHash,
        },
      })
    }

    // Check if already a member
    const existingMembership = await prisma.orgMember.findUnique({
      where: {
        userId_orgId: {
          userId: user.id,
          orgId: params.orgId,
        },
      },
    })

    if (existingMembership) {
      return NextResponse.json(
        { error: 'User is already a member of this organization' },
        { status: 409 }
      )
    }

    const member = await prisma.orgMember.create({
      data: {
        userId: user.id,
        orgId: params.orgId,
        role,
      },
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
    })

    return NextResponse.json({ member }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/orgs/[orgId]/members error:', err)
    return apiError(500, 'Internal server error')
  }
}
