import { NextRequest, NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/agent-auth'
import { handleMcpRequest, MCP_TOOLS } from '@/lib/mcp-server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/mcp
 * Returns the tool manifest. No authentication required.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ tools: MCP_TOOLS })
}

/**
 * POST /api/mcp
 * Authenticates via Bearer API key, then dispatches the JSON-RPC request
 * to the MCP server. Logging and webhook dispatch happen inside the
 * individual tool handlers in mcp-server.ts.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let agentCtx
  try {
    agentCtx = await requireApiKey(req)
  } catch (errorResponse) {
    // requireApiKey throws a NextResponse on auth failure
    return errorResponse as NextResponse
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: request body is not valid JSON' },
      },
      { status: 400 }
    )
  }

  const result = await handleMcpRequest(body, agentCtx)
  return NextResponse.json(result)
}
