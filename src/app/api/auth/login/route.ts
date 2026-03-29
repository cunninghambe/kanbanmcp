import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { sessionOptions, SessionData } from '@/lib/session'
import { verifyPassword } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
})

export async function POST(req: NextRequest) {
  // Rate limit: 10 attempts per IP per 15 minutes
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  if (!checkRateLimit(`login:${ip}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: 'Too many login attempts. Please try again later.' },
      { status: 429 }
    )
  }

  try {
    const body = await req.json()
    const result = loginSchema.safeParse(body)

    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      )
    }

    const { email, password } = result.data

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        orgMembers: {
          include: { org: true },
        },
      },
    })

    // Always run bcrypt comparison to prevent timing attacks that reveal email existence
    const DUMMY_HASH = '$2a$12$KIXHjPGKPqJDCsPBg4mUcuU5nNRKnOkNbBKXlLFRnRpQJkh7mFkHa'
    const hashToCheck = user?.passwordHash ?? DUMMY_HASH
    const valid = await verifyPassword(password, hashToCheck)

    if (!user || !valid) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // Find the primary org (first org the user is a member of)
    const primaryMembership = user.orgMembers[0]
    if (!primaryMembership) {
      return NextResponse.json(
        { error: 'User has no organization membership' },
        { status: 403 }
      )
    }

    // Write session cookie
    const session = await getIronSession<SessionData>(cookies(), sessionOptions)
    session.userId = user.id
    session.orgId = primaryMembership.orgId
    await session.save()

    return NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name },
      org: {
        id: primaryMembership.org.id,
        name: primaryMembership.org.name,
        slug: primaryMembership.org.slug,
      },
    })
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
