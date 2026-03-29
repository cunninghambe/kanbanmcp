import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { sessionOptions, SessionData } from '@/lib/session'
import { hashPassword } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'

const registerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  orgName: z.string().min(1, 'Organization name is required'),
})

export async function POST(req: NextRequest) {
  // Rate limit: 5 attempts per IP per 15 minutes
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  if (!checkRateLimit(`register:${ip}`, 5, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: 'Too many registration attempts. Please try again later.' },
      { status: 429 }
    )
  }

  try {
    const body = await req.json()
    const result = registerSchema.safeParse(body)

    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { name, email, password, orgName } = result.data

    // Check if user already exists
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json(
        { error: 'An account with this email already exists' },
        { status: 409 }
      )
    }

    const passwordHash = await hashPassword(password)

    // Generate a unique slug from org name
    const baseSlug = orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'org'
    const slug = `${baseSlug}-${Date.now()}`

    // Create user, org, and membership in a single transaction
    const { user, org } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name, passwordHash },
      })

      const org = await tx.organization.create({
        data: { name: orgName, slug },
      })

      await tx.orgMember.create({
        data: { userId: user.id, orgId: org.id, role: 'ADMIN' },
      })

      return { user, org }
    })

    // Write session cookie
    const session = await getIronSession<SessionData>(cookies(), sessionOptions)
    session.userId = user.id
    session.orgId = org.id
    await session.save()

    return NextResponse.json(
      {
        user: { id: user.id, email: user.email, name: user.name },
        org: { id: org.id, name: org.name, slug: org.slug },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Register error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
