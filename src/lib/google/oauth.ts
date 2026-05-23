import { encryptSecret, decryptSecret } from '../secrets'
import { prisma } from '../db'
import { googleFetch } from './fetch'
import {
  GoogleAuthExpiredError,
  GoogleHttpError,
  InsufficientScopesError,
  TokenRevokedError,
} from './errors'

export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
] as const

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

function requireEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('GOOGLE_OAUTH_* env vars not configured')
  }
  return { clientId, clientSecret, redirectUri }
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
}

type UserinfoResponse = {
  email: string
  sub: string
}

function isTokenResponse(v: unknown): v is TokenResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).access_token === 'string' &&
    typeof (v as Record<string, unknown>).expires_in === 'number' &&
    typeof (v as Record<string, unknown>).scope === 'string'
  )
}

function isUserinfoResponse(v: unknown): v is UserinfoResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).email === 'string' &&
    typeof (v as Record<string, unknown>).sub === 'string'
  )
}

function isInvalidGrant(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).error === 'invalid_grant'
  )
}

export function buildConsentUrl(userId: string, state: string): string {
  const { clientId, redirectUri } = requireEnv()
  const scopes = process.env.GOOGLE_SCOPES_OVERRIDE ?? REQUIRED_SCOPES.join(' ')
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  void userId // userId reserved for login_hint in future tasks
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

export interface ExchangeResult {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  email: string
  sub: string
  scopes: string[]
}

export async function exchangeCode(code: string): Promise<ExchangeResult> {
  const { clientId, clientSecret, redirectUri } = requireEnv()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  })

  const tokenRes = await googleFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!tokenRes.ok) {
    const text = await tokenRes.text()
    throw new GoogleHttpError(tokenRes.status, text)
  }

  const tokenData = await tokenRes.json()
  if (!isTokenResponse(tokenData)) throw new GoogleHttpError(200, 'Unexpected token response shape')

  const grantedScopes = tokenData.scope.split(' ')
  const missing = REQUIRED_SCOPES.filter((s) => !grantedScopes.includes(s))
  if (missing.length > 0) throw new InsufficientScopesError(missing)

  const userRes = await googleFetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const userInfo = await userRes.json()
  if (!isUserinfoResponse(userInfo)) throw new GoogleHttpError(userRes.status, 'Unexpected userinfo shape')

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? '',
    expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
    email: userInfo.email,
    sub: userInfo.sub,
    scopes: grantedScopes,
  }
}

export async function refreshAccessToken(userId: string): Promise<string> {
  const cred = await prisma.googleCredential.findUnique({ where: { userId } })
  if (!cred) throw new GoogleAuthExpiredError()

  const { clientId, clientSecret } = requireEnv()
  const refreshToken = decryptSecret(cred.refreshTokenEncrypted)

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  })

  const res = await googleFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const raw = await res.json().catch(() => null)
    if (res.status === 400 && isInvalidGrant(raw)) {
      await prisma.googleCredential.update({
        where: { userId },
        data: { accessToken: null, accessTokenExpiresAt: null },
      })
      throw new TokenRevokedError()
    }
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    throw new GoogleHttpError(res.status, text)
  }

  const data = await res.json()
  if (!isTokenResponse(data)) throw new GoogleHttpError(200, 'Unexpected refresh response shape')

  const now = new Date()
  const expiresAt = new Date(now.getTime() + data.expires_in * 1000)
  const updateData: {
    accessToken: string
    accessTokenExpiresAt: Date
    lastUsedAt: Date
    refreshTokenEncrypted?: string
  } = {
    accessToken: data.access_token,
    accessTokenExpiresAt: expiresAt,
    lastUsedAt: now,
  }
  if (data.refresh_token) {
    updateData.refreshTokenEncrypted = encryptSecret(data.refresh_token)
  }

  await prisma.googleCredential.update({ where: { userId }, data: updateData })
  return data.access_token
}

export async function revokeRefreshToken(userId: string): Promise<void> {
  const cred = await prisma.googleCredential.findUnique({ where: { userId } })
  if (!cred) return

  try {
    const refreshToken = decryptSecret(cred.refreshTokenEncrypted)
    const url = `${REVOKE_ENDPOINT}?token=${encodeURIComponent(refreshToken)}`
    await googleFetch(url, { method: 'POST' })
  } catch {
    // Best-effort: Google returns 400 for already-invalid tokens, which is the same desired state.
  }
}

export async function ensureFreshAccessToken(userId: string): Promise<string> {
  const cred = await prisma.googleCredential.findUnique({ where: { userId } })
  if (!cred) throw new GoogleAuthExpiredError()

  const thirtySecondsFromNow = new Date(Date.now() + 30 * 1000)
  if (cred.accessToken && cred.accessTokenExpiresAt && cred.accessTokenExpiresAt > thirtySecondsFromNow) {
    return cred.accessToken
  }

  return refreshAccessToken(userId)
}
