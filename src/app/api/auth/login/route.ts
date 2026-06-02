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

/**
 * Derives the client IP for rate-limiting from the trusted reverse proxy.
 *
 * SECURITY: X-Forwarded-For is a client-controllable list. The LEFTMOST entry
 * is supplied by the (untrusted) client, so keying the limiter on it lets an
 * attacker bypass throttling simply by rotating the header. We instead trust
 * only the hops appended by our own infrastructure and read from the RIGHT.
 *
 * Assumption: exactly TRUSTED_PROXY_HOPS reverse proxies sit in front of this
 * app (default 1 — a single nginx). The IP appended by the closest trusted
 * proxy is the entry at index (length - TRUSTED_PROXY_HOPS), counting from the
 * right. Anything to the left of that is attacker-controlled and ignored.
 * Falls back to x-real-ip (set by nginx) then 'unknown'.
 */
function clientIp(req: NextRequest): string {
  const hopsRaw = parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10)
  const trustedHops = Number.isNaN(hopsRaw) || hopsRaw < 1 ? 1 : hopsRaw

  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const chain = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    if (chain.length > 0) {
      // Pick the hop our closest trusted proxy appended, counting from the right.
      // Clamp so a chain shorter than the configured hop count still resolves to
      // the leftmost trusted entry rather than going out of bounds.
      const idx = Math.max(0, chain.length - trustedHops)
      return chain[idx]
    }
  }

  return req.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(req: NextRequest) {
  // Rate limit: 10 attempts per IP per 15 minutes.
  // Skipped during Playwright e2e runs so suites with many tests are not blocked.
  if (!process.env.PLAYWRIGHT_E2E) {
    const ip = clientIp(req)
    if (!checkRateLimit(`login:${ip}`, 10, 15 * 60 * 1000)) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        { status: 429 }
      )
    }
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
    const hashToCheck = user?.passwordHash || DUMMY_HASH
    const valid = await verifyPassword(password, hashToCheck)

    if (!user || !valid) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    // Block agent accounts from logging in via the human auth endpoint
    // (constant-time bcrypt check already done above to prevent timing oracles)
    if (user.isAgent) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    // Find the primary org (first org the user is a member of)
    const primaryMembership = user.orgMembers[0]
    if (!primaryMembership) {
      return NextResponse.json({ error: 'User has no organization membership' }, { status: 403 })
    }

    // Write session cookie
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions)
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
