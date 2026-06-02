import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireSession, apiError } from '@/lib/api-helpers'
import { buildConsentUrl } from '@/lib/google/oauth'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession(req)

    const state = randomBytes(32).toString('hex')
    const consentUrl = buildConsentUrl(session.userId, state)

    const secure = process.env.NODE_ENV === 'production'
    const cookieAttr = [
      `google_oauth_state=${state}`,
      'HttpOnly',
      secure ? 'Secure' : '',
      'SameSite=Lax',
      'Path=/api/me/google/callback',
      'Max-Age=600',
    ]
      .filter(Boolean)
      .join('; ')

    const res = NextResponse.redirect(consentUrl, { status: 302 })
    res.headers.set('Set-Cookie', cookieAttr)
    return res
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/me/google/connect error:', err)
    return apiError(500, 'Internal server error')
  }
}
