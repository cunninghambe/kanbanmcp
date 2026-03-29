import { NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/db'
import { sessionOptions, SessionData } from '@/lib/session'

export async function GET() {
  const session = await getIronSession<SessionData>(cookies(), sessionOptions)

  if (!session.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: {
      orgMembers: {
        include: { org: true },
      },
    },
  })

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 401 })
  }

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    },
    orgMemberships: user.orgMembers.map((m) => ({
      orgId: m.orgId,
      role: m.role,
      org: {
        id: m.org.id,
        name: m.org.name,
        slug: m.org.slug,
      },
    })),
  })
}
