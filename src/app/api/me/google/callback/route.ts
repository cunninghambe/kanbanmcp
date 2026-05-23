import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'
import { exchangeCode } from '@/lib/google/oauth'
import { encryptSecret } from '@/lib/secrets'
import { InsufficientScopesError } from '@/lib/google/errors'

const CLEAR_STATE_COOKIE =
  'google_oauth_state=; HttpOnly; SameSite=Lax; Path=/api/me/google/callback; Max-Age=0'

function stateMismatch(): NextResponse {
  return NextResponse.json(
    { error: 'STATE_MISMATCH' },
    { status: 400, headers: { 'Set-Cookie': CLEAR_STATE_COOKIE } }
  )
}

async function checkGoogleSubCollision(googleSub: string, userId: string): Promise<boolean> {
  const existing = await prisma.googleCredential.findFirst({ where: { googleSub } })
  return existing !== null && existing.userId !== userId
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code') ?? ''
  const queryState = searchParams.get('state') ?? ''
  const cookieState = req.cookies.get('google_oauth_state')?.value ?? ''

  if (!cookieState || queryState !== cookieState) {
    return stateMismatch()
  }

  let session
  try {
    session = await requireSession(req)
  } catch (err) {
    if (err instanceof NextResponse) {
      const res = new NextResponse(err.body, { status: err.status, headers: err.headers })
      res.headers.set('Set-Cookie', CLEAR_STATE_COOKIE)
      return res
    }
    return apiError(500, 'Internal server error')
  }

  let result
  try {
    result = await exchangeCode(code)
  } catch (err) {
    if (err instanceof InsufficientScopesError) {
      return NextResponse.json(
        { error: 'INSUFFICIENT_SCOPES', missing: err.missing },
        { status: 400, headers: { 'Set-Cookie': CLEAR_STATE_COOKIE } }
      )
    }
    console.error('OAuth exchange failed:', err)
    return NextResponse.json(
      { error: 'OAUTH_EXCHANGE_FAILED' },
      { status: 502, headers: { 'Set-Cookie': CLEAR_STATE_COOKIE } }
    )
  }

  if (!result.refreshToken) {
    return NextResponse.json(
      { error: 'OAUTH_EXCHANGE_FAILED' },
      { status: 502, headers: { 'Set-Cookie': CLEAR_STATE_COOKIE } }
    )
  }

  const collision = await checkGoogleSubCollision(result.sub, session.userId)
  if (collision) {
    return NextResponse.json(
      { error: 'GOOGLE_ACCOUNT_BOUND_TO_OTHER_USER' },
      { status: 409, headers: { 'Set-Cookie': CLEAR_STATE_COOKIE } }
    )
  }

  await prisma.googleCredential.upsert({
    where: { userId: session.userId },
    create: {
      userId: session.userId,
      accessToken: result.accessToken,
      refreshTokenEncrypted: encryptSecret(result.refreshToken),
      accessTokenExpiresAt: result.expiresAt,
      googleEmail: result.email,
      googleSub: result.sub,
      scopes: result.scopes.join(' '),
      lastUsedAt: null,
    },
    update: {
      accessToken: result.accessToken,
      refreshTokenEncrypted: encryptSecret(result.refreshToken),
      accessTokenExpiresAt: result.expiresAt,
      googleEmail: result.email,
      googleSub: result.sub,
      scopes: result.scopes.join(' '),
      lastUsedAt: null,
    },
  })

  const res = NextResponse.redirect(
    new URL('/settings/integrations?connected=1', req.url),
    { status: 302 }
  )
  res.headers.set('Set-Cookie', CLEAR_STATE_COOKIE)
  return res
}
