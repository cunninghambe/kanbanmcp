import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireSession, apiError } from '@/lib/api-helpers'
import { buildSlackConsentUrl } from '@/lib/slack/oauth'

const HUMAN_ONLY = 'Connecting Slack requires a human session'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // A Slack user token belongs to a person, never to an agent key. Reject the
    // bearer before it is looked up: this route can never serve an API key.
    if ((req.headers.get('authorization') ?? '').startsWith('Bearer ')) {
      return apiError(403, HUMAN_ONLY)
    }

    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, HUMAN_ONLY)

    const state = randomBytes(32).toString('hex')
    const consentUrl = buildSlackConsentUrl(state)

    const secure = process.env.NODE_ENV === 'production'
    const cookieAttr = [
      `slack_oauth_state=${state}`,
      'HttpOnly',
      secure ? 'Secure' : '',
      'SameSite=Lax',
      'Path=/api/me/slack/callback',
      'Max-Age=600',
    ]
      .filter(Boolean)
      .join('; ')

    const res = NextResponse.redirect(consentUrl, { status: 302 })
    res.headers.set('Set-Cookie', cookieAttr)
    return res
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/me/slack/connect error:', err)
    return apiError(500, 'Internal server error')
  }
}
