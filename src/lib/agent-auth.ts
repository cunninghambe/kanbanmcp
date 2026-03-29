import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { AgentContext } from '@/types/index'

/**
 * Authenticates an incoming request via a Bearer API key.
 * Hashes the raw key with SHA-256, looks it up in the ApiKey table,
 * updates lastUsedAt, and returns an AgentContext.
 * Throws a 401 Response if authentication fails.
 */
export async function requireApiKey(req: NextRequest): Promise<AgentContext> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw NextResponse.json(
      { error: 'Unauthorized: missing or malformed Authorization header' },
      { status: 401 }
    )
  }

  const rawKey = authHeader.slice('Bearer '.length).trim()
  if (!rawKey) {
    throw NextResponse.json(
      { error: 'Unauthorized: empty API key' },
      { status: 401 }
    )
  }

  const keyHash = createHash('sha256').update(rawKey).digest('hex')

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
  })

  if (!apiKey) {
    throw NextResponse.json(
      { error: 'Unauthorized: invalid API key' },
      { status: 401 }
    )
  }

  // Fire-and-forget lastUsedAt update — errors are silently ignored
  prisma.apiKey
    .update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {
      // Non-critical: do not block the request
    })

  let permissions: string[] = []
  try {
    const parsed = JSON.parse(apiKey.permissions)
    if (Array.isArray(parsed)) {
      permissions = parsed.filter((p): p is string => typeof p === 'string')
    }
  } catch {
    // Malformed JSON — treat as empty permissions
    permissions = []
  }

  return {
    orgId: apiKey.orgId,
    agentName: apiKey.agentName,
    keyId: apiKey.id,
    permissions,
  }
}
