import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, apiError } from '@/lib/api-helpers'
import { exchangeSlackCode } from '@/lib/slack/oauth'
import { authTest } from '@/lib/slack/client'
import { encryptSecret } from '@/lib/secrets'
import { SlackInsufficientScopesError } from '@/lib/slack/errors'

const CLEAR_STATE_COOKIE =
  'slack_oauth_state=; HttpOnly; SameSite=Lax; Path=/api/me/slack/callback; Max-Age=0'

function stateMismatch(): NextResponse {
  return NextResponse.json(
    { error: 'STATE_MISMATCH' },
    { status: 400, headers: { 'Set-Cookie': CLEAR_STATE_COOKIE } }
  )
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code') ?? ''
  const oauthError = searchParams.get('error') ?? ''
  const queryState = searchParams.get('state') ?? ''
  const cookieState = req.cookies.get('slack_oauth_state')?.value ?? ''

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

  if (oauthError) {
    const res = NextResponse.redirect(
      new URL(`/settings/integrations?slack_error=${encodeURIComponent(oauthError)}`, req.url),
      { status: 302 }
    )
    res.headers.set('Set-Cookie', CLEAR_STATE_COOKIE)
    return res
  }

  let result
  try {
    result = await exchangeSlackCode(code)
  } catch (err) {
    if (err instanceof SlackInsufficientScopesError) {
      return NextResponse.json(
        { error: 'INSUFFICIENT_SCOPES', missing: err.missing },
        { status: 400, headers: { 'Set-Cookie': CLEAR_STATE_COOKIE } }
      )
    }
    console.error('Slack OAuth exchange failed:', err)
    return NextResponse.json(
      { error: 'OAUTH_EXCHANGE_FAILED' },
      { status: 502, headers: { 'Set-Cookie': CLEAR_STATE_COOKIE } }
    )
  }

  // auth.test only supplies the workspace URL used to build permalinks; a
  // failure here must not cost the user their connection.
  let teamUrl: string | null = null
  try {
    const identity = await authTest(result.accessToken)
    teamUrl = identity.url || null
  } catch (err) {
    console.error('Slack auth.test failed (continuing without a team url):', err)
  }

  const existing = await prisma.slackCredential.findFirst({
    where: { teamId: result.teamId, slackUserId: result.slackUserId },
  })
  if (existing && existing.userId !== session.userId) {
    return NextResponse.json(
      { error: 'SLACK_ACCOUNT_BOUND_TO_OTHER_USER' },
      { status: 409, headers: { 'Set-Cookie': CLEAR_STATE_COOKIE } }
    )
  }

  const fields = {
    teamId: result.teamId,
    teamName: result.teamName,
    teamUrl,
    slackUserId: result.slackUserId,
    accessTokenEncrypted: encryptSecret(result.accessToken),
    scopes: result.scopes.join(','),
    lastUsedAt: null,
  }

  await prisma.slackCredential.upsert({
    where: { userId: session.userId },
    create: { userId: session.userId, ...fields },
    update: { ...fields },
  })

  const res = NextResponse.redirect(new URL('/settings/integrations?connected=slack', req.url), {
    status: 302,
  })
  res.headers.set('Set-Cookie', CLEAR_STATE_COOKIE)
  return res
}
