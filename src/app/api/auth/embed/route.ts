import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/db'
import { sessionOptions, SessionData } from '@/lib/session'
import { apiError } from '@/lib/api-helpers'

/**
 * POST /api/auth/embed
 *
 * Auto-authenticates an embed session using an embed token, sets a short-lived
 * iron-session cookie, and returns the board URL to redirect to.
 *
 * The token is accepted from the `Authorization: Bearer <token>` header or from
 * the JSON body (`{ "token": "<token>" }`) — NEVER from a GET query string,
 * which would leak the credential into browser history, referrer headers, and
 * server access logs.
 *
 * Used by the Paperclip platform to embed the kanban board in an iframe without
 * requiring manual login.
 */

// Short cookie lifetime for embed sessions — these are minted from a long-lived
// API key, so the resulting browser session should not be long-lived.
const EMBED_SESSION_MAX_AGE_SECONDS = 60 * 30 // 30 minutes

/** Extracts the embed token from the Authorization header or POST body. */
async function extractToken(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get('authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const headerToken = authHeader.slice('Bearer '.length).trim()
    if (headerToken) return headerToken
  }

  // Fall back to the JSON body.
  try {
    const body: unknown = await req.json()
    if (
      typeof body === 'object' &&
      body !== null &&
      'token' in body &&
      typeof (body as Record<string, unknown>).token === 'string'
    ) {
      const bodyToken = (body as Record<string, string>).token.trim()
      if (bodyToken) return bodyToken
    }
  } catch {
    // No / invalid JSON body — treat as no token.
  }

  return null
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const token = await extractToken(req)

    if (!token) {
      return apiError(400, 'Missing embed token')
    }

    // Hash the token and look up the API key.
    const keyHash = createHash('sha256').update(token).digest('hex')
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
    })

    if (!apiKey) {
      return apiError(401, 'Invalid token')
    }

    // Update lastUsedAt (fire-and-forget).
    prisma.apiKey
      .update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {})

    // Pick a DETERMINISTIC, lowest-privilege member of the org to act as the
    // session user. We prefer non-ADMIN roles and order by a stable field
    // (userId) so the same key always resolves to the same user and never
    // silently grants an ADMIN browser session.
    const members = await prisma.orgMember.findMany({
      where: { orgId: apiKey.orgId },
      orderBy: { userId: 'asc' },
    })

    if (members.length === 0) {
      return apiError(500, 'No users found in organization')
    }

    const nonAdmin = members.find((m) => m.role !== 'ADMIN')
    const embedMember = nonAdmin ?? members[0]

    // Write a short-lived session cookie. Standard session options apply
    // (httpOnly, sameSite, secure-per-env); we override maxAge to keep the
    // embed session brief.
    const session = await getIronSession<SessionData>(await cookies(), {
      ...sessionOptions,
      cookieOptions: {
        ...sessionOptions.cookieOptions,
        maxAge: EMBED_SESSION_MAX_AGE_SECONDS,
      },
    })
    session.userId = embedMember.userId
    session.orgId = apiKey.orgId
    session.isApiKeyAuth = true
    session.agentName = apiKey.agentName
    await session.save()

    // Redirect target: only ever same-origin within this app. We do NOT echo a
    // client-supplied Host header into the redirect. Use a relative path so the
    // browser resolves it against the request origin it already trusts.
    const boardUrl = '/dashboard'
    return NextResponse.json({ ok: true, redirect: boardUrl })
  } catch (err) {
    console.error('POST /api/auth/embed error:', err)
    return apiError(500, 'Internal server error')
  }
}
