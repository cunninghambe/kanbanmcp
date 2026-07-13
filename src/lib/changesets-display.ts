import type { PrismaClient } from '@prisma/client'
import type { z } from 'zod'
import { opPayloadSchemas, type ChangeOp } from './changesets'

/**
 * Human-readable rendering of ChangeSet items — resolves the card/column/board
 * ids referenced in op payloads to names. Pure over pre-fetched rows aside
 * from its own batched reads: one `findMany` per referenced entity type,
 * regardless of item count. Every read is scoped to `orgId` — payload ids are
 * not validated against the org at propose time, so an unscoped lookup here
 * would let a foreign-org id resolve to a real name. Never throws — malformed
 * payloads and missing/foreign-org referents both degrade to readable
 * placeholder strings.
 */

export interface ChangeItemDisplay {
  itemId: string
  display: string
}

interface DisplayItemInput {
  id: string
  op: string
  payload: string
  targetCardId: string | null
}

type CreateCardPayload = { op: 'create_card'; data: z.infer<typeof opPayloadSchemas.create_card> }
type MoveCardPayload = { op: 'move_card'; data: z.infer<typeof opPayloadSchemas.move_card> }
type UpdateCardPayload = { op: 'update_card'; data: z.infer<typeof opPayloadSchemas.update_card> }
type CommentCardPayload = { op: 'comment_card'; data: z.infer<typeof opPayloadSchemas.comment_card> }
type ParsedPayload = CreateCardPayload | MoveCardPayload | UpdateCardPayload | CommentCardPayload

interface ParsedItem {
  id: string
  op: string
  targetCardId: string | null
  payload: ParsedPayload | null // null = malformed JSON or schema-invalid
}

type CardRow = { title: string; columnId: string }

function isChangeOp(op: string): op is ChangeOp {
  return op in opPayloadSchemas
}

function notFound(id: string): string {
  return `${id} (not found)`
}

/** Parses one item's payload against its op's schema. Never throws. */
function parsePayload(op: ChangeOp, raw: string): ParsedPayload | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  switch (op) {
    case 'create_card': {
      const result = opPayloadSchemas.create_card.safeParse(json)
      return result.success ? { op, data: result.data } : null
    }
    case 'move_card': {
      const result = opPayloadSchemas.move_card.safeParse(json)
      return result.success ? { op, data: result.data } : null
    }
    case 'update_card': {
      const result = opPayloadSchemas.update_card.safeParse(json)
      return result.success ? { op, data: result.data } : null
    }
    case 'comment_card': {
      const result = opPayloadSchemas.comment_card.safeParse(json)
      return result.success ? { op, data: result.data } : null
    }
  }
}

/** Collects the referenced card/column/board ids across every item, for batched lookup. */
function collectReferencedIds(items: ParsedItem[]) {
  const cardIds = new Set<string>()
  const columnIds = new Set<string>()
  const boardIds = new Set<string>()

  for (const item of items) {
    if (!item.payload) continue
    switch (item.payload.op) {
      case 'create_card':
        columnIds.add(item.payload.data.columnId)
        boardIds.add(item.payload.data.boardId)
        break
      case 'move_card':
        cardIds.add(item.targetCardId ?? item.payload.data.cardId)
        columnIds.add(item.payload.data.columnId)
        break
      case 'update_card':
      case 'comment_card':
        cardIds.add(item.targetCardId ?? item.payload.data.cardId)
        break
    }
  }

  return { cardIds, columnIds, boardIds }
}

export async function describeChangeItems(
  db: PrismaClient,
  orgId: string,
  items: DisplayItemInput[]
): Promise<ChangeItemDisplay[]> {
  const parsed: ParsedItem[] = items.map((item) => ({
    id: item.id,
    op: item.op,
    targetCardId: item.targetCardId,
    payload: isChangeOp(item.op) ? parsePayload(item.op, item.payload) : null,
  }))

  const { cardIds, columnIds, boardIds } = collectReferencedIds(parsed)

  const cards = cardIds.size
    ? await db.card.findMany({
        where: { id: { in: [...cardIds] }, board: { orgId } },
        select: { id: true, title: true, columnId: true },
      })
    : []
  const cardMap = new Map<string, CardRow>(cards.map((c) => [c.id, { title: c.title, columnId: c.columnId }]))
  for (const card of cards) columnIds.add(card.columnId)

  const columns = columnIds.size
    ? await db.column.findMany({
        where: { id: { in: [...columnIds] }, board: { orgId } },
        select: { id: true, name: true },
      })
    : []
  const columnMap = new Map(columns.map((c) => [c.id, c.name]))

  const boards = boardIds.size
    ? await db.board.findMany({ where: { id: { in: [...boardIds] }, orgId }, select: { id: true, name: true } })
    : []
  const boardMap = new Map(boards.map((b) => [b.id, b.name]))

  return parsed.map((item) => ({
    itemId: item.id,
    display: renderItem(item, cardMap, columnMap, boardMap),
  }))
}

function renderItem(
  item: ParsedItem,
  cardMap: Map<string, CardRow>,
  columnMap: Map<string, string>,
  boardMap: Map<string, string>
): string {
  if (!item.payload) return `${item.op} (unreadable payload)`

  switch (item.payload.op) {
    case 'create_card':
      return renderCreateCard(item.payload.data, columnMap, boardMap)
    case 'move_card':
      return renderMoveCard(item.payload.data, item.targetCardId, cardMap, columnMap)
    case 'update_card':
      return renderUpdateCard(item.payload.data, item.targetCardId, cardMap)
    case 'comment_card':
      return renderCommentCard(item.payload.data, item.targetCardId, cardMap)
  }
}

function renderCreateCard(
  data: CreateCardPayload['data'],
  columnMap: Map<string, string>,
  boardMap: Map<string, string>
): string {
  const columnName = columnMap.get(data.columnId) ?? notFound(data.columnId)
  const boardName = boardMap.get(data.boardId) ?? notFound(data.boardId)
  return `Create card "${data.title}" in ${columnName} on ${boardName}`
}

/** The card a move/update/comment op targets: `targetCardId` (if retargeted) wins over the payload's `cardId`. */
function resolveCard(
  cardIdFromPayload: string,
  targetCardId: string | null,
  cardMap: Map<string, CardRow>
): { title: string; row: CardRow | undefined } {
  const cardId = targetCardId ?? cardIdFromPayload
  const row = cardMap.get(cardId)
  return { title: row ? row.title : notFound(cardId), row }
}

function renderMoveCard(
  data: MoveCardPayload['data'],
  targetCardId: string | null,
  cardMap: Map<string, CardRow>,
  columnMap: Map<string, string>
): string {
  const { title: cardTitle, row: card } = resolveCard(data.cardId, targetCardId, cardMap)
  const fromColumn = card ? (columnMap.get(card.columnId) ?? notFound(card.columnId)) : cardTitle
  const toColumn = columnMap.get(data.columnId) ?? notFound(data.columnId)
  return `Move "${cardTitle}" from ${fromColumn} to ${toColumn}`
}

const UPDATE_FIELD_LABELS: Array<[key: 'title' | 'description' | 'priority' | 'dueDate', label: string]> = [
  ['title', 'title'],
  ['description', 'description'],
  ['priority', 'priority'],
  ['dueDate', 'due'],
]

function renderUpdateCard(
  data: UpdateCardPayload['data'],
  targetCardId: string | null,
  cardMap: Map<string, CardRow>
): string {
  const { title: cardTitle } = resolveCard(data.cardId, targetCardId, cardMap)

  const parts: string[] = []
  for (const [key, label] of UPDATE_FIELD_LABELS) {
    if (key === 'dueDate') {
      if (data.dueDate === undefined) continue
      parts.push(`${label}: ${data.dueDate === null ? '(none)' : data.dueDate.slice(0, 10)}`)
      continue
    }
    const value = data[key]
    if (value !== undefined) parts.push(`${label}: ${value}`)
  }

  return `Update "${cardTitle}": ${parts.join(', ')}`
}

function renderCommentCard(
  data: CommentCardPayload['data'],
  targetCardId: string | null,
  cardMap: Map<string, CardRow>
): string {
  const { title: cardTitle } = resolveCard(data.cardId, targetCardId, cardMap)
  const excerpt = data.content.length > 80 ? `${data.content.slice(0, 80)}…` : data.content
  return `Comment on "${cardTitle}": "${excerpt}"`
}
