import { NextRequest, NextResponse } from 'next/server'
import { requireSession, apiError } from '@/lib/api-helpers'
import { readRegistry } from '@/lib/claude-mcp-registry'

export async function GET(req: NextRequest) {
  try {
    await requireSession(req)
    const registry = await readRegistry()
    return NextResponse.json({ projects: Object.keys(registry) })
  } catch (err) {
    if (err instanceof NextResponse) return err
    console.error('GET /api/me/claude-projects error:', err)
    return apiError(500, 'Internal server error')
  }
}
