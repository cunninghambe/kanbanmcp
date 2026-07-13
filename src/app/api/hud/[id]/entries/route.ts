import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireSession, requireOrgRole, apiError } from '@/lib/api-helpers'
import { parseCapture } from '@/lib/host-hud/capture'
import { resolveMemberNames } from '@/lib/host-hud/members'

const ENTRY_KINDS = ['agenda', 'note', 'decision', 'action'] as const

const createEntrySchema = z.object({
  kind: z.enum(ENTRY_KINDS),
  text: z.string().trim().min(1).max(2000),
  position: z.number().int().min(0).optional(), // default = max+1 within (session, kind)
})

interface AssigneeCandidate {
  id: string
  name: string
}

// GET /api/hud/[id]/entries — every entry for this session, ordered for display.
// Allowed on live or ended sessions (post-meeting review/cleanup).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const hud = await prisma.hudSession.findFirst({
      where: { id, orgId: session.orgId },
      select: { id: true },
    })
    if (!hud) return apiError(404, 'HUD session not found')

    const entries = await prisma.hudEntry.findMany({
      where: { hudSessionId: id },
      orderBy: [{ kind: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    })

    const assigneeIds = entries.map((e) => e.assigneeId).filter((v): v is string => v !== null)
    const memberNames = await resolveMemberNames(prisma, session.orgId, assigneeIds)
    const withNames = entries.map((e) => ({
      ...e,
      assigneeName: e.assigneeId ? (memberNames.get(e.assigneeId) ?? null) : null,
    }))

    return NextResponse.json({ entries: withNames })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/hud/[id]/entries error:', err)
    return apiError(500, 'Internal server error')
  }
}

// POST /api/hud/[id]/entries — chair creates an agenda/note/decision/action
// entry. Human session only; action entries run through the quick-capture
// parser server-side (agenda/note/decision text is stored verbatim).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    const session = await requireSession(req)
    if (session.isApiKeyAuth) return apiError(403, 'Creating a HUD entry requires a human session')
    await requireOrgRole(session, session.orgId, 'MEMBER')

    const hud = await prisma.hudSession.findFirst({
      where: { id, orgId: session.orgId },
      select: { id: true, status: true },
    })
    if (!hud) return apiError(404, 'HUD session not found')
    if (hud.status !== 'live') return apiError(409, 'HUD session is not live')

    const parsed = createEntrySchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    const position = parsed.data.position ?? (await nextPosition(id, parsed.data.kind))
    const base = { orgId: session.orgId, hudSessionId: id, authorId: session.userId, position }

    if (parsed.data.kind === 'action') {
      return createActionEntry(base, parsed.data.text)
    }

    const entry = await prisma.hudEntry.create({
      data: { ...base, kind: parsed.data.kind, text: parsed.data.text },
    })
    return NextResponse.json({ entry }, { status: 201 })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('POST /api/hud/[id]/entries error:', err)
    return apiError(500, 'Internal server error')
  }
}

async function nextPosition(hudSessionId: string, kind: string): Promise<number> {
  const agg = await prisma.hudEntry.aggregate({
    where: { hudSessionId, kind },
    _max: { position: true },
  })
  return (agg._max.position ?? 0) + 1
}

interface NewEntryBase {
  orgId: string
  hudSessionId: string
  authorId: string
  position: number
}

/** Runs the quick-capture parser and assignee resolution, then creates the action entry. */
async function createActionEntry(base: NewEntryBase, rawText: string): Promise<NextResponse> {
  const capture = parseCapture(rawText, new Date())
  if (capture.text.length === 0) return apiError(400, 'text is required')

  const { assigneeId, resolution, candidates } = await resolveAssignee(base.orgId, capture.assigneeQuery)
  const entry = await prisma.hudEntry.create({
    data: { ...base, kind: 'action', text: capture.text, assigneeId, dueDate: capture.dueDate },
  })
  return NextResponse.json(
    { entry, assigneeResolution: resolution, ...(candidates ? { candidates } : {}) },
    { status: 201 }
  )
}

/**
 * Resolves a quick-capture `@mention` query against org members by
 * case-insensitive prefix match on name or email local-part. Zero matches
 * resolve to 'none' (saved unassigned); more than one resolve to 'ambiguous'
 * (saved unassigned, up to 5 candidates returned for the chair to pick from).
 */
async function resolveAssignee(
  orgId: string,
  query: string | null
): Promise<{
  assigneeId: string | null
  resolution: 'resolved' | 'none' | 'ambiguous'
  candidates?: AssigneeCandidate[]
}> {
  if (!query) return { assigneeId: null, resolution: 'none' }

  const members = await prisma.orgMember.findMany({
    where: { orgId },
    include: { user: { select: { id: true, name: true, email: true } } },
  })

  const lowerQuery = query.toLowerCase()
  const matches = new Map<string, AssigneeCandidate>()
  for (const { user } of members) {
    const localPart = user.email.split('@')[0]
    if (user.name.toLowerCase().startsWith(lowerQuery) || localPart.toLowerCase().startsWith(lowerQuery)) {
      matches.set(user.id, { id: user.id, name: user.name })
    }
  }

  const candidates = [...matches.values()].sort((a, b) => a.name.localeCompare(b.name))
  if (candidates.length === 0) return { assigneeId: null, resolution: 'none' }
  if (candidates.length === 1) return { assigneeId: candidates[0].id, resolution: 'resolved' }
  return { assigneeId: null, resolution: 'ambiguous', candidates: candidates.slice(0, 5) }
}
