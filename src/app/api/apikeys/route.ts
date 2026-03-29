import { createHash, randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

const createApiKeySchema = z.object({
  agentName: z.string().min(1, 'agentName is required'),
  permissions: z.array(z.string()).default([]),
})

/**
 * GET /api/apikeys
 * Returns all API keys for the session user's organization.
 * keyHash is omitted from the response.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  let session
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    return errorResponse as NextResponse
  }

  const apiKeys = await prisma.apiKey.findMany({
    where: { orgId: session.orgId },
    orderBy: { createdAt: 'desc' },
  })

  const sanitized = apiKeys.map(({ keyHash: _keyHash, permissions, ...rest }) => ({
    ...rest,
    permissions: (() => {
      try {
        const parsed = JSON.parse(permissions)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })(),
  }))

  return NextResponse.json(sanitized)
}

/**
 * POST /api/apikeys
 * Creates a new API key for the session user's organization.
 * Returns the raw key once — it cannot be retrieved again.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let session
  try {
    session = await requireSession(req)
  } catch (errorResponse) {
    return errorResponse as NextResponse
  }

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = createApiKeySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation error', details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const { agentName, permissions } = parsed.data

  const rawKey = randomBytes(32).toString('hex')
  const keyHash = createHash('sha256').update(rawKey).digest('hex')

  const apiKey = await prisma.apiKey.create({
    data: {
      orgId: session.orgId,
      name: agentName,
      keyHash,
      agentName,
      permissions: JSON.stringify(permissions),
    },
  })

  return NextResponse.json(
    {
      id: apiKey.id,
      agentName: apiKey.agentName,
      key: rawKey,
      permissions,
      createdAt: apiKey.createdAt,
    },
    { status: 201 }
  )
}
