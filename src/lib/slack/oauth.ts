/**
 * Slack OAuth v2 user-token flow (spec §4.7). Env is read at call time, never
 * at import, so the module loads fine on a deployment without Slack.
 */
import { prisma } from '../db'
import { decryptSecret } from '../secrets'
import { slackFetch } from './fetch'
import {
  SlackApiError,
  SlackAuthError,
  SlackHttpError,
  SlackInsufficientScopesError,
} from './errors'

export const SLACK_USER_SCOPES = [
  'search:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'users:read',
  'chat:write',
  'channels:read',
  'groups:read',
] as const

const AUTHORIZE_ENDPOINT = 'https://slack.com/oauth/v2/authorize'
const ACCESS_ENDPOINT = 'https://slack.com/api/oauth.v2.access'
const REVOKE_ENDPOINT = 'https://slack.com/api/auth.revoke'
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8'

function requireSlackEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.SLACK_CLIENT_ID
  const clientSecret = process.env.SLACK_CLIENT_SECRET
  const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('SLACK_OAUTH_* env vars not configured')
  }
  return { clientId, clientSecret, redirectUri }
}

export interface SlackExchangeResult {
  accessToken: string
  scopes: string[]
  teamId: string
  teamName: string
  slackUserId: string
}

export function buildSlackConsentUrl(state: string): string {
  const { clientId, redirectUri } = requireSlackEnv()
  const params = new URLSearchParams({
    client_id: clientId,
    user_scope: SLACK_USER_SCOPES.join(','),
    redirect_uri: redirectUri,
    state,
  })
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function parseScopes(raw: unknown): string[] {
  return typeof raw === 'string'
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
}

export async function exchangeSlackCode(code: string): Promise<SlackExchangeResult> {
  const { clientId, clientSecret, redirectUri } = requireSlackEnv()
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  })

  const res = await slackFetch(ACCESS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': FORM_CONTENT_TYPE },
    body: body.toString(),
  })
  if (!res.ok) throw new SlackHttpError(res.status, await res.text())

  const data = asRecord(await res.json())
  if (data.ok !== true) {
    throw new SlackApiError(typeof data.error === 'string' ? data.error : 'unknown_error')
  }

  const authedUser = asRecord(data.authed_user)
  const team = asRecord(data.team)
  const accessToken = authedUser.access_token
  const slackUserId = authedUser.id
  if (typeof accessToken !== 'string' || !accessToken || typeof slackUserId !== 'string') {
    throw new SlackApiError('missing_user_token', 'Slack returned no user token')
  }

  const scopes = parseScopes(authedUser.scope)
  const missing = SLACK_USER_SCOPES.filter((scope) => !scopes.includes(scope))
  if (missing.length > 0) throw new SlackInsufficientScopesError(missing)

  return {
    accessToken,
    scopes,
    teamId: typeof team.id === 'string' ? team.id : '',
    teamName: typeof team.name === 'string' ? team.name : '',
    slackUserId,
  }
}

/** Decrypts the stored user token. Throws SlackAuthError when the user has no credential. */
export async function getSlackAccessToken(
  userId: string
): Promise<{ token: string; slackUserId: string; teamId: string; teamUrl: string | null }> {
  const cred = await prisma.slackCredential.findUnique({ where: { userId } })
  if (!cred) throw new SlackAuthError()

  const token = decryptSecret(cred.accessTokenEncrypted)

  prisma.slackCredential
    .update({ where: { userId }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      // Non-critical: never block a read on the usage stamp.
    })

  return {
    token,
    slackUserId: cred.slackUserId,
    teamId: cred.teamId,
    teamUrl: cred.teamUrl ?? null,
  }
}

/** Best-effort token revocation on disconnect. Never throws. */
export async function revokeSlackToken(userId: string): Promise<void> {
  try {
    const cred = await prisma.slackCredential.findUnique({ where: { userId } })
    if (!cred) return
    const token = decryptSecret(cred.accessTokenEncrypted)
    await slackFetch(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': FORM_CONTENT_TYPE },
      body: '',
    })
  } catch {
    // Best-effort: a revoked-at-Slack or unreachable token must not block disconnect.
  }
}
