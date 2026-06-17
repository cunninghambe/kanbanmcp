import { prisma } from '@/lib/db'
import { logActivity } from '@/lib/agent-activity'
import { dispatchWebhook } from '@/lib/webhook'
import { recordCardMovement } from '@/lib/card-movement'
import {
  computeChildPathAndDepth,
  MAX_NESTING_DEPTH,
  roleMembershipCheck,
  aiReviewParamsSchema,
  decodeAiReviewParams,
} from '@/lib/cards'
import { fetchSubtree } from '@/lib/tree'
import { shapeArtifact } from '@/lib/artifacts'
import { proposeChangeSetInputSchema, createPendingChangeSet } from '@/lib/changesets'
import type { AgentContext } from '@/types/index'

const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'critical'] as const
type Priority = (typeof VALID_PRIORITIES)[number]

function isValidPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (VALID_PRIORITIES as readonly string[]).includes(value)
}

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
        priority: {
          type: 'string',
          enum: ['none', 'low', 'medium', 'high', 'critical'],
          description: 'Optional card priority level. Defaults to "none".',
        },
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
        priority: {
          type: 'string',
          enum: ['none', 'low', 'medium', 'high', 'critical'],
          description: 'Card priority level.',
        },
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
  {
    name: 'create_subcard',
    description:
      "Create a child card under an existing parent card. The new card inherits the parent's board and column unless columnId is provided.",
    inputSchema: {
      type: 'object',
      properties: {
        parentCardId: { type: 'string', description: 'ID of the parent card.' },
        title: { type: 'string' },
        description: { type: 'string' },
        assigneeId: { type: 'string', description: 'Required org member id.' },
        reviewerId: { type: 'string', description: 'Optional org member id.' },
        approverId: { type: 'string', description: 'Optional org member id.' },
        columnId: {
          type: 'string',
          description: "Optional override; defaults to the parent card's column.",
        },
        priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'critical'] },
        dueDate: { type: 'string', description: 'Optional ISO 8601 datetime.' },
      },
      required: ['parentCardId', 'title', 'assigneeId'],
    },
  },
  {
    name: 'set_card_reviewers',
    description:
      'Update the reviewerId and/or approverId on a card. Pass null to clear; omit to leave unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        reviewerId: { type: ['string', 'null'] },
        approverId: { type: ['string', 'null'] },
      },
      required: ['cardId'],
    },
  },
  {
    name: 'toggle_ai_review',
    description:
      'Toggle aiAutoReview on a card and optionally set aiReviewParams. Enabling this flag does NOT trigger review of already-uploaded artifacts (see list_artifacts + artifact review endpoints for that).',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        enabled: { type: 'boolean' },
        params: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            rubric: { type: 'string' },
            customInstructions: { type: 'string' },
          },
          required: ['model', 'rubric'],
        },
      },
      required: ['cardId', 'enabled'],
    },
  },
  {
    name: 'list_card_tree',
    description: 'List the subtree rooted at a card up to `depth` levels (default 1, max 5).',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        depth: { type: 'number', description: 'Default 1, max 5.' },
      },
      required: ['cardId'],
    },
  },
  {
    name: 'record_signoff',
    description:
      'Record a signoff decision as the calling user. NOTE: This tool always returns an error in M1 because MCP authentication is API-key-only and signoffs require a human user session. This tool surface is reserved for future cookie-based MCP auth.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        role: { type: 'string', enum: ['REVIEWER', 'APPROVER'] },
        decision: { type: 'string', enum: ['APPROVED', 'REJECTED', 'REQUESTED_CHANGES'] },
        comment: { type: 'string' },
      },
      required: ['cardId', 'role', 'decision'],
    },
  },
  {
    name: 'list_artifacts',
    description:
      'List artifacts for a card with their AI reviews, ordered by creation time descending.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
      },
      required: ['cardId'],
    },
  },
  {
    name: 'propose_changeset',
    description:
      'Propose a set of board changes for HUMAN approval. This creates a PENDING ChangeSet — it NEVER mutates the board. Each item is a validated op (create_card | move_card | update_card | comment_card) with optional evidence and confidence. Use this instead of the direct mutation tools when an agent should suggest, not apply.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Board the changes target (resolution scope).' },
        summary: { type: 'string', description: 'Human-readable summary of the proposal.' },
        items: {
          type: 'array',
          description: 'Proposed ops.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['create_card', 'move_card', 'update_card', 'comment_card'],
              },
              payload: { type: 'object', description: 'Op-specific payload (validated per op).' },
              targetCardId: { type: 'string' },
              evidence: {
                type: 'object',
                properties: { quote: { type: 'string' } },
                required: ['quote'],
              },
              confidence: { type: 'number' },
            },
            required: ['op', 'payload'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'list_pending_changesets',
    description: 'List pending ChangeSets for the organization, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max records (default 20, max 100).' },
      },
    },
  },
  {
    name: 'get_changeset',
    description: 'Retrieve a ChangeSet with all of its items.',
    inputSchema: {
      type: 'object',
      properties: {
        changeSetId: { type: 'string' },
      },
      required: ['changeSetId'],
    },
  },
  {
    name: 'list_card_movements',
    description:
      'List column-change history for a board (or a single card), newest first. Only records ' +
      'moves made after this feature was deployed — there is no historical backfill.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Board to list movements for (one of boardId | cardId required).' },
        cardId: { type: 'string', description: 'Single card to list movements for.' },
        sinceDays: { type: 'number', description: 'Look-back window in days (default 14, max 90).' },
        limit: { type: 'number', description: 'Max rows (default 50, max 200).' },
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Permission scoping
// ---------------------------------------------------------------------------
// ApiKey.permissions is a JSON string array. Back-compat rule: an EMPTY array
// means "legacy key, full access" (preserves all existing agents). A non-empty
// array is an explicit allowlist — write tools require 'write' (or '*'/'admin'),
// proposal requires 'write' or 'propose'. This realizes MEETINGCOPILOTSPEC §6.2:
// a read-scoped key (e.g. ['read','propose']) can read + propose but never mutate.

const WRITE_TOOLS = new Set([
  'create_card',
  'update_card',
  'move_card',
  'add_comment',
  'create_subcard',
  'set_card_reviewers',
  'toggle_ai_review',
])

const PROPOSE_TOOLS = new Set(['propose_changeset'])

export function isToolAllowed(toolName: string, permissions: string[]): boolean {
  if (permissions.length === 0) return true // legacy key — full access
  if (permissions.includes('*') || permissions.includes('admin')) return true
  if (WRITE_TOOLS.has(toolName)) return permissions.includes('write')
  if (PROPOSE_TOOLS.has(toolName)) {
    return permissions.includes('write') || permissions.includes('propose')
  }
  return true // read-only tools are always permitted for any scoped key
}

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

  // Validate priority if provided
  if (params.priority !== undefined && !isValidPriority(params.priority)) {
    throw { code: -32602, message: 'priority must be one of: none, low, medium, high, critical' }
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

  // Validate dueDate before creating
  if (params.dueDate) {
    const d = new Date(params.dueDate as string)
    if (isNaN(d.getTime())) {
      throw { code: -32602, message: 'dueDate must be a valid ISO 8601 date string' }
    }
  }

  const card = await prisma.card.create({
    data: {
      title,
      description: params.description ? (params.description as string) : undefined,
      columnId,
      boardId,
      sprintId: params.sprintId ? (params.sprintId as string) : undefined,
      priority: isValidPriority(params.priority) ? params.priority : 'none',
      position,
      agentId: agentCtx.agentName,
      createdById: orgMember.userId,
      dueDate: params.dueDate ? new Date(params.dueDate as string) : undefined,
    },
  })

  // Log and dispatch webhook (fire-and-forget)
  logActivity(agentCtx.orgId, agentCtx.agentName, 'create_card', 'card', card.id, {
    title,
    boardId,
    columnId,
  }).catch(() => {})

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

  // Validate priority if provided
  if (params.priority !== undefined && !isValidPriority(params.priority)) {
    throw { code: -32602, message: 'priority must be one of: none, low, medium, high, critical' }
  }

  // Verify the card belongs to the agent's org
  const existing = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId: agentCtx.orgId } },
  })
  if (!existing) throw { code: -32602, message: 'Card not found or access denied' }

  // Validate assigneeId is a member of the agent's org (prevent IDOR cross-org assignment)
  if (params.assigneeId !== undefined && params.assigneeId !== null) {
    const assigneeMembership = await prisma.orgMember.findUnique({
      where: { userId_orgId: { userId: params.assigneeId as string, orgId: agentCtx.orgId } },
    })
    if (!assigneeMembership) {
      throw { code: -32602, message: 'Assignee must be a member of this organization' }
    }
  }

  // Validate dueDate before passing to new Date() to avoid runtime errors
  if (params.dueDate !== undefined && params.dueDate !== null) {
    const d = new Date(params.dueDate as string)
    if (isNaN(d.getTime())) {
      throw { code: -32602, message: 'dueDate must be a valid ISO 8601 date string' }
    }
  }

  const updateData: Record<string, unknown> = {}
  if (params.title !== undefined) {
    if (typeof params.title !== 'string' || (params.title as string).length === 0) {
      throw { code: -32602, message: 'title must be a non-empty string' }
    }
    updateData.title = params.title as string
  }
  if (params.description !== undefined) updateData.description = params.description as string
  if (params.dueDate !== undefined)
    updateData.dueDate = params.dueDate ? new Date(params.dueDate as string) : null
  if (params.assigneeId !== undefined) updateData.assigneeId = params.assigneeId as string
  if (params.sprintId !== undefined) updateData.sprintId = params.sprintId as string
  if (isValidPriority(params.priority)) updateData.priority = params.priority

  const card = await prisma.card.update({
    where: { id: cardId },
    data: updateData,
  })

  logActivity(agentCtx.orgId, agentCtx.agentName, 'update_card', 'card', card.id, {
    updatedFields: Object.keys(updateData),
  }).catch(() => {})

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

  const card = await prisma.$transaction(async (tx) => {
    const updated = await tx.card.update({
      where: { id: cardId },
      data: { columnId, position },
    })
    await recordCardMovement(tx, {
      cardId,
      boardId: existing.boardId,
      orgId: agentCtx.orgId,
      fromColumnId: existing.columnId,
      toColumnId: columnId,
      movedBy: { id: agentCtx.agentName, kind: 'agent' },
    })
    return updated
  })

  logActivity(agentCtx.orgId, agentCtx.agentName, 'move_card', 'card', card.id, {
    fromColumnId: existing.columnId,
    toColumnId: columnId,
    position,
  }).catch(() => {})

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

  logActivity(agentCtx.orgId, agentCtx.agentName, 'add_comment', 'comment', comment.id, {
    cardId,
    contentLength: content.length,
  }).catch(() => {})

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

async function toolCreateSubcard(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const parentCardId = params.parentCardId as string
  const title = params.title as string
  const assigneeId = params.assigneeId as string

  if (!parentCardId) throw { code: -32602, message: 'parentCardId is required' }
  if (!title) throw { code: -32602, message: 'title is required' }
  if (!assigneeId) throw { code: -32602, message: 'assigneeId is required' }

  if (params.priority !== undefined && !isValidPriority(params.priority)) {
    throw { code: -32602, message: 'priority must be one of: none, low, medium, high, critical' }
  }

  const parent = await prisma.card.findFirst({
    where: { id: parentCardId, board: { orgId: agentCtx.orgId } },
    select: { id: true, path: true, depth: true, columnId: true, boardId: true },
  })
  if (!parent) throw { code: -32602, message: 'Parent card not found or access denied' }

  if (parent.depth + 1 >= MAX_NESTING_DEPTH) {
    throw { code: -32602, message: `Maximum nesting depth (${MAX_NESTING_DEPTH}) reached` }
  }

  const roleIds = [assigneeId, params.reviewerId, params.approverId].filter(
    (id): id is string => typeof id === 'string'
  )
  const memberCheck = await roleMembershipCheck(prisma, roleIds, agentCtx.orgId)
  if (!memberCheck.ok) {
    throw {
      code: -32602,
      message: `User ${memberCheck.missingId} is not a member of this organization`,
    }
  }

  const columnId = typeof params.columnId === 'string' ? params.columnId : parent.columnId

  if (params.dueDate) {
    const d = new Date(params.dueDate as string)
    if (isNaN(d.getTime()))
      throw { code: -32602, message: 'dueDate must be a valid ISO 8601 date string' }
  }

  const aggregate = await prisma.card.aggregate({
    where: { columnId },
    _max: { position: true },
  })
  const position = (aggregate._max.position ?? 0) + 1

  const orgMember = await prisma.orgMember.findFirst({
    where: { orgId: agentCtx.orgId },
    orderBy: { role: 'asc' },
    select: { userId: true },
  })
  if (!orgMember) throw { code: -32602, message: 'No org member found to associate card with' }

  const { path, depth } = computeChildPathAndDepth(parent)

  const card = await prisma.card.create({
    data: {
      title,
      description: typeof params.description === 'string' ? params.description : undefined,
      columnId,
      boardId: parent.boardId,
      parentCardId,
      path,
      depth,
      assigneeId,
      reviewerId: typeof params.reviewerId === 'string' ? params.reviewerId : undefined,
      approverId: typeof params.approverId === 'string' ? params.approverId : undefined,
      priority: isValidPriority(params.priority) ? params.priority : 'none',
      position,
      agentId: agentCtx.agentName,
      createdById: orgMember.userId,
      dueDate: params.dueDate ? new Date(params.dueDate as string) : undefined,
    },
  })

  logActivity(agentCtx.orgId, agentCtx.agentName, 'create_subcard', 'card', card.id, {
    title,
    parentCardId,
    boardId: parent.boardId,
    columnId,
  }).catch(() => {})

  dispatchWebhook(agentCtx.orgId, 'card.created', {
    cardId: card.id,
    title: card.title,
    parentCardId,
    boardId: parent.boardId,
    columnId,
    agentName: agentCtx.agentName,
  }).catch(() => {})

  return card
}

async function toolSetCardReviewers(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const cardId = params.cardId as string
  if (!cardId) throw { code: -32602, message: 'cardId is required' }

  const existing = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId: agentCtx.orgId } },
  })
  if (!existing) throw { code: -32602, message: 'Card not found or access denied' }

  const idsToCheck = [params.reviewerId, params.approverId].filter(
    (id): id is string => typeof id === 'string'
  )
  if (idsToCheck.length > 0) {
    const memberCheck = await roleMembershipCheck(prisma, idsToCheck, agentCtx.orgId)
    if (!memberCheck.ok) {
      throw {
        code: -32602,
        message: `User ${memberCheck.missingId} is not a member of this organization`,
      }
    }
  }

  const updateData: Record<string, string | null> = {}
  if ('reviewerId' in params) updateData.reviewerId = params.reviewerId as string | null
  if ('approverId' in params) updateData.approverId = params.approverId as string | null

  const card = await prisma.card.update({
    where: { id: cardId },
    data: updateData,
  })

  logActivity(agentCtx.orgId, agentCtx.agentName, 'set_card_reviewers', 'card', card.id, {
    updatedFields: Object.keys(updateData),
  }).catch(() => {})

  dispatchWebhook(agentCtx.orgId, 'card.updated', {
    cardId: card.id,
    updatedFields: Object.keys(updateData),
    agentName: agentCtx.agentName,
  }).catch(() => {})

  return card
}

async function toolToggleAiReview(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const cardId = params.cardId as string
  if (!cardId) throw { code: -32602, message: 'cardId is required' }
  if (typeof params.enabled !== 'boolean')
    throw { code: -32602, message: 'enabled must be a boolean' }

  const existing = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId: agentCtx.orgId } },
  })
  if (!existing) throw { code: -32602, message: 'Card not found or access denied' }

  const updateData: Record<string, unknown> = { aiAutoReview: params.enabled }

  if (params.params !== undefined) {
    const parsed = aiReviewParamsSchema.safeParse(params.params)
    if (!parsed.success) {
      throw {
        code: -32602,
        message: `Invalid aiReviewParams: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      }
    }
    updateData.aiReviewParams = JSON.stringify(parsed.data)
  }

  const card = await prisma.card.update({
    where: { id: cardId },
    data: updateData,
  })

  logActivity(agentCtx.orgId, agentCtx.agentName, 'toggle_ai_review', 'card', card.id, {
    enabled: params.enabled,
  }).catch(() => {})

  dispatchWebhook(agentCtx.orgId, 'card.updated', {
    cardId: card.id,
    updatedFields: ['aiAutoReview', ...(params.params !== undefined ? ['aiReviewParams'] : [])],
    agentName: agentCtx.agentName,
  }).catch(() => {})

  return { ...card, aiReviewParams: decodeAiReviewParams(card.aiReviewParams) }
}

async function toolListCardTree(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const cardId = params.cardId as string
  if (!cardId) throw { code: -32602, message: 'cardId is required' }

  const existing = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId: agentCtx.orgId } },
    select: { id: true, boardId: true },
  })
  if (!existing) throw { code: -32602, message: 'Card not found or access denied' }

  const rawDepth = typeof params.depth === 'number' ? params.depth : 1
  const depth = Math.min(Math.max(rawDepth, 0), 5)

  const { nodes, truncated } = await fetchSubtree(prisma, cardId, depth, existing.boardId)

  const [root, ...descendants] = nodes
  return { root, descendants, truncated }
}

async function toolRecordSignoff(
  _params: Record<string, unknown>,
  _agentCtx: AgentContext
): Promise<unknown> {
  throw {
    code: -32602,
    message: 'record_signoff requires a human user session; MCP is API-key-only in M1',
  }
}

async function toolListArtifacts(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const cardId = params.cardId as string
  if (!cardId) throw { code: -32602, message: 'cardId is required' }

  const existing = await prisma.card.findFirst({
    where: { id: cardId, board: { orgId: agentCtx.orgId } },
    select: { id: true },
  })
  if (!existing) throw { code: -32602, message: 'Card not found or access denied' }

  const artifacts = await prisma.artifact.findMany({
    where: { cardId },
    orderBy: { createdAt: 'desc' },
    include: { uploader: true, reviews: true },
  })

  return { artifacts: artifacts.map(shapeArtifact) }
}

async function toolProposeChangeset(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const parsed = proposeChangeSetInputSchema.safeParse(params)
  if (!parsed.success) {
    throw {
      code: -32602,
      message: `Invalid propose_changeset input: ${parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    }
  }

  // If a board is named, confirm it belongs to the agent's org (prevent cross-org IDOR).
  if (parsed.data.boardId) {
    const board = await prisma.board.findFirst({
      where: { id: parsed.data.boardId, orgId: agentCtx.orgId },
      select: { id: true },
    })
    if (!board) throw { code: -32602, message: 'Board not found or access denied' }
  }

  const changeSet = await createPendingChangeSet(prisma, {
    orgId: agentCtx.orgId,
    createdById: agentCtx.agentName,
    boardId: parsed.data.boardId,
    summary: parsed.data.summary,
    items: parsed.data.items,
  })

  logActivity(agentCtx.orgId, agentCtx.agentName, 'propose_changeset', 'change_set', changeSet.id, {
    boardId: parsed.data.boardId ?? null,
    itemCount: changeSet.items.length,
  }).catch(() => {})

  dispatchWebhook(agentCtx.orgId, 'changeset.proposed', {
    changeSetId: changeSet.id,
    itemCount: changeSet.items.length,
    agentName: agentCtx.agentName,
  }).catch(() => {})

  return { changeSetId: changeSet.id, status: changeSet.status, itemCount: changeSet.items.length }
}

async function toolListPendingChangesets(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const limit = typeof params.limit === 'number' ? Math.min(Math.max(params.limit, 1), 100) : 20
  const changeSets = await prisma.changeSet.findMany({
    where: { orgId: agentCtx.orgId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { _count: { select: { items: true } } },
  })
  return changeSets.map((cs) => ({
    id: cs.id,
    status: cs.status,
    summary: cs.summary,
    boardId: cs.boardId,
    itemCount: cs._count.items,
    createdAt: cs.createdAt,
  }))
}

async function toolGetChangeset(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const changeSetId = params.changeSetId as string
  if (!changeSetId) throw { code: -32602, message: 'changeSetId is required' }

  const changeSet = await prisma.changeSet.findFirst({
    where: { id: changeSetId, orgId: agentCtx.orgId },
    include: { items: true },
  })
  if (!changeSet) throw { code: -32602, message: 'ChangeSet not found or access denied' }

  return {
    ...changeSet,
    items: changeSet.items.map((it) => ({
      ...it,
      payload: safeJsonParse(it.payload),
      evidence: it.evidence ? safeJsonParse(it.evidence) : null,
      resolution: it.resolution ? safeJsonParse(it.resolution) : null,
    })),
  }
}

async function toolListCardMovements(
  params: Record<string, unknown>,
  agentCtx: AgentContext
): Promise<unknown> {
  const boardId = typeof params.boardId === 'string' ? params.boardId : undefined
  const cardId = typeof params.cardId === 'string' ? params.cardId : undefined
  if (!boardId && !cardId) throw { code: -32602, message: 'boardId or cardId is required' }

  const sinceDays = typeof params.sinceDays === 'number' ? Math.min(Math.max(params.sinceDays, 1), 90) : 14
  const limit = typeof params.limit === 'number' ? Math.min(Math.max(params.limit, 1), 200) : 50
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)

  if (boardId) {
    const board = await prisma.board.findFirst({ where: { id: boardId, orgId: agentCtx.orgId }, select: { id: true } })
    if (!board) throw { code: -32602, message: 'Board not found or access denied' }
  }
  if (cardId) {
    const card = await prisma.card.findFirst({ where: { id: cardId, board: { orgId: agentCtx.orgId } }, select: { id: true } })
    if (!card) throw { code: -32602, message: 'Card not found or access denied' }
  }

  const rows = await prisma.cardMovement.findMany({
    where: {
      orgId: agentCtx.orgId,
      movedAt: { gte: since },
      ...(boardId ? { boardId } : {}),
      ...(cardId ? { cardId } : {}),
    },
    orderBy: { movedAt: 'desc' },
    take: limit + 1,
    include: { card: { select: { title: true } } },
  })
  const truncated = rows.length > limit
  const page = rows.slice(0, limit)

  const boardIds = [...new Set(page.map((r) => r.boardId))]
  const columns = boardIds.length
    ? await prisma.column.findMany({ where: { boardId: { in: boardIds }, board: { orgId: agentCtx.orgId } }, select: { id: true, name: true } })
    : []
  const colName = new Map(columns.map((c) => [c.id, c.name]))
  const name = (id: string | null) => (id ? (colName.get(id) ?? id) : null)

  return {
    movements: page.map((r) => ({
      cardId: r.cardId,
      cardTitle: r.card?.title ?? null,
      fromColumn: name(r.fromColumnId),
      toColumn: name(r.toColumnId),
      movedBy: r.movedById,
      movedByKind: r.movedByKind,
      movedAt: r.movedAt,
    })),
    truncated,
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
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
  create_subcard: toolCreateSubcard,
  set_card_reviewers: toolSetCardReviewers,
  toggle_ai_review: toolToggleAiReview,
  list_card_tree: toolListCardTree,
  record_signoff: toolRecordSignoff,
  list_artifacts: toolListArtifacts,
  propose_changeset: toolProposeChangeset,
  list_pending_changesets: toolListPendingChangesets,
  get_changeset: toolGetChangeset,
  list_card_movements: toolListCardMovements,
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
export async function handleMcpRequest(body: unknown, agentCtx: AgentContext): Promise<unknown> {
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

  // Enforce ApiKey permission scope (read-only / propose-only keys cannot mutate).
  if (!isToolAllowed(toolName, agentCtx.permissions)) {
    return rpcError(
      id,
      -32004,
      `Permission denied: API key is not scoped to call "${toolName}"`
    )
  }

  try {
    const result = await handler(toolParams, agentCtx)
    return rpcSuccess(id, result)
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
      const e = err as { code: number; message: string; data?: unknown }
      return rpcError(id, e.code, e.message, e.data)
    }
    // Unexpected error — do not leak internal error details to callers
    console.error('[MCP] Unhandled tool error:', err)
    return rpcError(id, -32603, 'Internal server error')
  }
}
