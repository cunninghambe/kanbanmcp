import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/db'
import { sessionOptions, SessionData } from '@/lib/session'

/**
 * GET /api/auth/embed?token=<API_KEY>
 *
 * Auto-authenticates an embed session using an API key,
 * sets an iron-session cookie, and redirects to the board.
 * Used by the Paperclip platform to embed the kanban board
 * in an iframe without requiring manual login.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')

  if (!token) {
    return NextResponse.json(
      { error: 'Missing token query parameter' },
      { status: 400 }
    )
  }

  // Hash the token and look up the API key
  const keyHash = createHash('sha256').update(token).digest('hex')
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
  })

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Invalid token' },
      { status: 401 }
    )
  }

  // Update lastUsedAt (fire-and-forget)
  prisma.apiKey
    .update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {})

  // Find an admin/owner user in this org to set as session user,
  // or fall back to any user in the org
  const orgMember = await prisma.orgMember.findFirst({
    where: { orgId: apiKey.orgId },
  })

  if (!orgMember) {
    return NextResponse.json(
      { error: 'No users found in organization' },
      { status: 500 }
    )
  }

  // Write session cookie using standard session options (SameSite=Lax).
  // Both Paperclip and KanbanMCP are on the same IP (same-site), so Lax works.
  // SameSite=None requires Secure (HTTPS) which we don't have.
  const session = await getIronSession<SessionData>(cookies(), sessionOptions)
  session.userId = orgMember.userId
  session.orgId = apiKey.orgId
  session.isApiKeyAuth = true
  session.agentName = apiKey.agentName
  await session.save()

  // Redirect to the board — use the Host header so the redirect
  // goes to the public IP the browser used, not localhost
  const host = req.headers.get('host') || req.nextUrl.host
  const proto = req.headers.get('x-forwarded-proto') || 'http'
  const boardUrl = `${proto}://${host}/dashboard`
  return NextResponse.redirect(boardUrl, { status: 302 })
}
