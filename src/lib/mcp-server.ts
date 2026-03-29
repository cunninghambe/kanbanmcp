import { prisma } from '@/lib/db'
import { logActivity } from '@/lib/agent-activity'
import { dispatchWebhook } from '@/lib/webhook'
import type { AgentContext } from '@/types/index'

// ---------------------------------------------------------------------------
// Tool manifest
// ---------------------------------------------------------------------------

export interface McpToolSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface McpTool {
  name: string
  description: string
  inputSchema: McpToolSchema
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'list_boards',
    description: 'List all boards for an organization with column and card counts.',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: {
          type: 'string',
          description: 'The organization ID to list boards for.',
        },
      },
      required: ['orgId'],
    },
  },
  {
    name: 'get_board',
    description:
      'Retrieve a board with all columns (ordered by position) and cards within each column (ordered by position).',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'The board ID.' },
      },
      required: ['boardId'],
    },
  },
  {
    name: 'create_card',
    description: 'Create a new card in a specified column on a board.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'The board ID.' },
        columnId: { type: 'string', description: 'The column ID to place the card in.' },
        title: { type: 'string', description: 'Card title.' },
        description: { type: 'string', description: 'Optional card description.' },
        dueDate: {
          type: 'string',
          description: 'Optional ISO 8601 due date string.',
        },
        sprintId: { type: 'string', description: 'Optional sprint ID to assign the card to.' },
      },
      required: ['boardId', 'columnId', 'title'],
    },
  },
  {
    name: 'update_card',
    description: 'Update fields on an existing card.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The card ID to update.' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
        dueDate: { type: 'string', description: 'New ISO 8601 due date.' },
        assigneeId: { type: 'string', description: 'User ID to assign the card to.' },
        sprintId: { type: 'string', description: 'Sprint ID to assign the card to.' },
      },
      required: ['cardId'],
    },
  },
  {
    name: 'move_card',
    description: 'Move a card to a different column and/or position.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The card ID to move.' },
        columnId: { type: 'string', description: 'Target column ID.' },
        position: { type: 'number', description: 'Target position (1-indexed).' },
      },
      required: ['cardId', 'columnId', 'position'],
    },
  },
  {
    name: 'list_sprints',
    description: 'List all sprints for a board.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'The board ID.' },
      },
      required: ['boardId'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to a card from the agent.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The card ID to comment on.' },
        content: { type: 'string', description: 'Comment text.' },
      },
      required: ['cardId', 'content'],
    },
  },
  {
    name: 'get_activity',
    description: 'Retrieve paginated agent activity logs for an organization.',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: { type: 'string', description: 'The organization ID.' },
        limit: {
          type: 'number',
          description: 'Maximum number of records to return (default 20).',
        },
        page: { type: 'number', description: 'Page number, 1-indexed (default 1).' },
      },
      required: ['orgId'],
    },
  },
]

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string
  id: string | number | null
  method: string
  params?: Record<string, unknown>
}

function rpcSuccess(id: string | number | null, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): unknown {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolListBoards(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  // Always scope to the authenticated agent's org
  const orgId = agentCtx.orgId

  const boards = await prisma.board.findMany({
    where: { orgId },
    include: {
      _count: {
        select: {
          columns: true,
          cards: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return boards.map((b) => ({
    id: b.id,
    name: b.name,
    orgId: b.orgId,
    createdAt: b.createdAt,
    columnCount: b._count.columns,
    cardCount: b._count.cards,
  }))
}

async function toolGetBoard(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const boardId = params.boardId as string
  if (!boardId) throw { code: -32602, message: 'boardId is required' }

  const board = await prisma.board.findFirst({
    where: { id: boardId, orgId: agentCtx.orgId },
    include: {
      columns: {
        orderBy: { position: 'asc' },
        include: {
          cards: {
            orderBy: { position: 'asc' },
          },
        },
      },
    },
  })

  if (!board) throw { code: -32602, message: 'Board not found or access denied' }

  return board
}

async function toolCreateCard(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const boardId = params.boardId as string
  const columnId = params.columnId as string
  const title = params.title as string

  if (!boardId || !columnId || !title) {
    throw { code: -32602, message: 'boardId, columnId, and title are required' }
  }

  // Verify the board belongs to the agent's org
  const board = await prisma.board.findFirst({
    where: { id: boardId, orgId: agentCtx.orgId },
  })
  if (!board) throw { code: -32602, message: 'Board not found or access denied' }

  // Verify column belongs to board
  const column = await prisma.column.findFirst({
    where: { id: columnId, boardId },
  })
  if (!column) throw { code: -32602, message: 'Column not found on board' }

  // Compute next position
  const aggregate = await prisma.card.aggregate({
    where: { columnId },
    _max: { position: true },
  })
  const position = (aggregate._max.position ?? 0) + 1

  // Agents create cards without a real userId — use a sentinel value
  // We need a valid createdById; find any org member to use as creator
  // or use agentName as a label only (agentId field)
  // Per schema Card.createdById is non-nullable, so we look for the org's first admin
  const orgMember = await prisma.orgMember.findFirst({
    where: { orgId: agentCtx.orgId },
    orderBy: { role: 'asc' },
    select: { userId: true },
  })

  if (!orgMember) {
    throw { code: -32602, message: 'No org member found to associate card with' }
  }

  const card = await prisma.card.create({
    data: {
      title,
      description: params.description ? (params.description as string) : undefined,
      columnId,
      boardId,
      sprintId: params.sprintId ? (params.sprintId as string) : undefined,
      position,
      agentId: agentCtx.agentName,
      createdById: orgMember.userId,
      dueDate: params.dueDate ? new Date(params.dueDate as string) : undefined,
    },
  })

  // Log and dispatch webhook (fire-and-forget)
  logActivity(
    agentCtx.orgId,
    agentCtx.agentName,
    'create_card',
    'card',
    card.id,
    { title, boardId, columnId }
  ).catch(() => {})

  dispatchWebhook(agentCtx.orgId, 'card.created', {
    cardId: card.id,
    title: card.title,
    boardId,
    columnId,
    agentName: agentCtx.agentName,
  }).catch(() => {})

  return card
}

async function toolUpdateCard(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const cardId = params.cardId as string
  if (!cardId) throw { code: -32602, message: 'cardId is required' }

  // Verify the card belongs to the agent's org
  const existing = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId: agentCtx.orgId } },
  })
  if (!existing) throw { code: -32602, message: 'Card not found or access denied' }

  const updateData: Record<string, unknown> = {}
  if (params.title !== undefined) updateData.title = params.title as string
  if (params.description !== undefined) updateData.description = params.description as string
  if (params.dueDate !== undefined)
    updateData.dueDate = params.dueDate ? new Date(params.dueDate as string) : null
  if (params.assigneeId !== undefined) updateData.assigneeId = params.assigneeId as string
  if (params.sprintId !== undefined) updateData.sprintId = params.sprintId as string

  const card = await prisma.card.update({
    where: { id: cardId },
    data: updateData,
  })

  logActivity(
    agentCtx.orgId,
    agentCtx.agentName,
    'update_card',
    'card',
    card.id,
    { updatedFields: Object.keys(updateData) }
  ).catch(() => {})

  dispatchWebhook(agentCtx.orgId, 'card.updated', {
    cardId: card.id,
    updatedFields: Object.keys(updateData),
    agentName: agentCtx.agentName,
  }).catch(() => {})

  return card
}

async function toolMoveCard(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const cardId = params.cardId as string
  const columnId = params.columnId as string
  const position = params.position as number

  if (!cardId || !columnId || position === undefined) {
    throw { code: -32602, message: 'cardId, columnId, and position are required' }
  }

  // Verify the card belongs to the agent's org
  const existing = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId: agentCtx.orgId } },
  })
  if (!existing) throw { code: -32602, message: 'Card not found or access denied' }

  // Verify target column belongs to same board
  const column = await prisma.column.findFirst({
    where: { id: columnId, boardId: existing.boardId },
  })
  if (!column) throw { code: -32602, message: 'Target column not found on board' }

  const card = await prisma.card.update({
    where: { id: cardId },
    data: { columnId, position },
  })

  logActivity(
    agentCtx.orgId,
    agentCtx.agentName,
    'move_card',
    'card',
    card.id,
    { fromColumnId: existing.columnId, toColumnId: columnId, position }
  ).catch(() => {})

  dispatchWebhook(agentCtx.orgId, 'card.moved', {
    cardId: card.id,
    fromColumnId: existing.columnId,
    toColumnId: columnId,
    position,
    agentName: agentCtx.agentName,
  }).catch(() => {})

  return card
}

async function toolListSprints(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const boardId = params.boardId as string
  if (!boardId) throw { code: -32602, message: 'boardId is required' }

  // Ensure board belongs to org
  const board = await prisma.board.findFirst({
    where: { id: boardId, orgId: agentCtx.orgId },
  })
  if (!board) throw { code: -32602, message: 'Board not found or access denied' }

  const sprints = await prisma.sprint.findMany({
    where: { boardId },
    orderBy: { startDate: 'asc' },
  })

  return sprints
}

async function toolAddComment(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const cardId = params.cardId as string
  const content = params.content as string

  if (!cardId || !content) {
    throw { code: -32602, message: 'cardId and content are required' }
  }

  // Verify card belongs to org
  const card = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId: agentCtx.orgId } },
  })
  if (!card) throw { code: -32602, message: 'Card not found or access denied' }

  const comment = await prisma.comment.create({
    data: {
      cardId,
      userId: null,
      agentId: agentCtx.agentName,
      content,
    },
  })

  logActivity(
    agentCtx.orgId,
    agentCtx.agentName,
    'add_comment',
    'comment',
    comment.id,
    { cardId, contentLength: content.length }
  ).catch(() => {})

  dispatchWebhook(agentCtx.orgId, 'card.updated', {
    cardId,
    event: 'comment_added',
    commentId: comment.id,
    agentName: agentCtx.agentName,
  }).catch(() => {})

  return comment
}

async function toolGetActivity(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  // Always scope to the agent's org
  const orgId = agentCtx.orgId
  const limit = typeof params.limit === 'number' ? Math.min(params.limit, 100) : 20
  const page = typeof params.page === 'number' ? Math.max(params.page, 1) : 1
  const skip = (page - 1) * limit

  const [activities, total] = await Promise.all([
    prisma.agentActivity.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip,
    }),
    prisma.agentActivity.count({ where: { orgId } }),
  ])

  return {
    activities: activities.map((a) => ({
      ...a,
      metadata: (() => {
        try {
          return JSON.parse(a.metadata)
        } catch {
          return a.metadata
        }
      })(),
    })),
    total,
    page,
    limit,
  }
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

const TOOL_HANDLERS: Record<
  string,
  (params: Record<string, unknown>, agentCtx: AgentContext) => Promise<unknown>
> = {
  list_boards: toolListBoards,
  get_board: toolGetBoard,
  create_card: toolCreateCard,
  update_card: toolUpdateCard,
  move_card: toolMoveCard,
  list_sprints: toolListSprints,
  add_comment: toolAddComment,
  get_activity: toolGetActivity,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Handles a JSON-RPC 2.0 request from an MCP client.
 * Supports:
 *   - method = "tools/call" with params { name, arguments }
 *   - method = "<tool_name>" with params = arguments directly
 */
export async function handleMcpRequest(
  body: unknown,
  agentCtx: AgentContext
): Promise<unknown> {
  // Basic structure validation
  if (
    typeof body !== 'object' ||
    body === null ||
    !('jsonrpc' in body) ||
    (body as Record<string, unknown>).jsonrpc !== '2.0' ||
    !('method' in body)
  ) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    }
  }

  const rpc = body as JsonRpcRequest
  const id = rpc.id ?? null

  let toolName: string
  let toolParams: Record<string, unknown>

  if (rpc.method === 'tools/call') {
    // Standard MCP tools/call form
    const p = rpc.params ?? {}
    toolName = (p.name as string) ?? ''
    toolParams = (p.arguments as Record<string, unknown>) ?? {}
  } else {
    // Direct method invocation: method = tool name
    toolName = rpc.method
    toolParams = (rpc.params ?? {}) as Record<string, unknown>
  }

  const handler = TOOL_HANDLERS[toolName]
  if (!handler) {
    return rpcError(id, -32601, `Method not found: ${toolName}`)
  }

  try {
    const result = await handler(toolParams, agentCtx)
    return rpcSuccess(id, result)
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      'message' in err
    ) {
      const e = err as { code: number; message: string; data?: unknown }
      return rpcError(id, e.code, e.message, e.data)
    }
    // Unexpected error
    const message = err instanceof Error ? err.message : 'Internal error'
    return rpcError(id, -32603, message)
  }
}
