import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole } from '@/lib/api-helpers'
import { encryptSecret } from '@/lib/secrets'

// Permissive: non-empty, no whitespace, max 512 chars.
// Intentionally broad — Anthropic key formats may evolve.
const API_KEY_RE = /^\S{10,512}$/

type RouteContext = { params: Promise<{ orgId: string }> }

export async function GET(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { orgId } = await ctx.params

  try {
    const session = await requireSession(req)
    await requireOrgRole(session, orgId, 'MEMBER')
  } catch (err) {
    if (err instanceof NextResponse) return err
    throw err
  }

  const settings = await prisma.orgAiSettings.findUnique({ where: { orgId } })
  return NextResponse.json({
    anthropicApiKey: {
      configured: settings?.anthropicApiKeyEncrypted != null,
      lastFour: settings?.anthropicApiKeyLastFour ?? null,
    },
  })
}

export async function PUT(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { orgId } = await ctx.params

  let session
  try {
    session = await requireSession(req)
    await requireOrgRole(session, orgId, 'ADMIN')
  } catch (err) {
    if (err instanceof NextResponse) return err
    throw err
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof body !== 'object' || body === null || !('anthropicApiKey' in body)) {
    return NextResponse.json({ error: 'Missing anthropicApiKey field' }, { status: 400 })
  }

  const anthropicApiKey = (body as Record<string, unknown>).anthropicApiKey

  if (anthropicApiKey === null) {
    await prisma.orgAiSettings.upsert({
      where: { orgId },
      create: { orgId, anthropicApiKeyEncrypted: null, anthropicApiKeyLastFour: null },
      update: { anthropicApiKeyEncrypted: null, anthropicApiKeyLastFour: null },
    })
    return NextResponse.json({ ok: true })
  }

  if (typeof anthropicApiKey !== 'string' || !API_KEY_RE.test(anthropicApiKey)) {
    return NextResponse.json(
      { error: 'anthropicApiKey must be a non-empty string (10–512 chars, no whitespace)' },
      { status: 400 }
    )
  }

  const encrypted = encryptSecret(anthropicApiKey)
  const lastFour = anthropicApiKey.slice(-4)

  await prisma.orgAiSettings.upsert({
    where: { orgId },
    create: { orgId, anthropicApiKeyEncrypted: encrypted, anthropicApiKeyLastFour: lastFour },
    update: { anthropicApiKeyEncrypted: encrypted, anthropicApiKeyLastFour: lastFour },
  })

  return NextResponse.json({ ok: true })
}
