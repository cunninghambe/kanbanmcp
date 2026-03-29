import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { sessionOptions, SessionData } from '@/lib/session'

// In-memory sliding-window rate limiter for auth endpoints.
// 10 requests per IP per 15-minute window.
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000

const authRateLimitMap = new Map<string, number[]>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const windowStart = now - RATE_LIMIT_WINDOW_MS
  const timestamps = (authRateLimitMap.get(ip) ?? []).filter((t) => t > windowStart)
  timestamps.push(now)
  authRateLimitMap.set(ip, timestamps)
  return timestamps.length > RATE_LIMIT_MAX
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Rate-limit authentication endpoints
  if (pathname.startsWith('/api/auth/')) {
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
      req.headers.get('x-real-ip') ??
      'unknown'

    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: 'Too many requests, please try again later' },
        { status: 429, headers: { 'Retry-After': '900' } }
      )
    }

    return NextResponse.next()
  }

  // Session guard for protected page routes
  const res = NextResponse.next()

  try {
    const session = await getIronSession<SessionData>(req, res, sessionOptions)

    if (!session.userId) {
      const loginUrl = new URL('/login', req.url)
      return NextResponse.redirect(loginUrl)
    }

    return res
  } catch {
    const loginUrl = new URL('/login', req.url)
    return NextResponse.redirect(loginUrl)
  }
}

export const config = {
  matcher: [
    '/api/auth/:path*',
    '/dashboard/:path*',
    '/board/:path*',
    '/sprints/:path*',
    '/settings/:path*',
    '/activity/:path*',
  ],
}
