/**
 * Planner end-to-end against real SQLite (spec §9): seeded cards → collect →
 * ranked today → done write-through moves the card → sticky on re-collect;
 * quick add, snooze, and a card-comment handoff.
 *
 * Strategy (mirrors m4-google-end-to-end.test.ts):
 *   - Real prisma → real SQLite (DATABASE_URL from vitest.config)
 *   - Real route handlers, real service/collector/sources/write-through
 *   - iron-session mocked with a configurable userId/orgId
 *   - Schema applied with `prisma db push` in beforeAll (planner tables have no migration)
 *   - Per-test unique suffix; cleanup deletes planner rows, then the org (cascade), then the user
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'

const mockSession = { userId: '', orgId: '', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))
vi.mock('next/headers', () => ({ cookies: vi.fn().mockReturnValue({}) }))

import { prisma } from '../../src/lib/db'
import { localDate } from '../../src/lib/planner/time'

const NOW = new Date()
const DATE = localDate(NOW, 'UTC')
const DAY = 24 * 60 * 60 * 1000

type Ctx = {
  orgId: string
  userId: string
  otherUserId: string
  boardId: string
  cols: Record<string, string>
  cards: Record<string, string>
}

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function seed(): Promise<Ctx> {
  const s = randomUUID().replace(/-/g, '').slice(0, 12)
  const org = await prisma.organization.create({
    data: { name: `PlannerOrg-${s}`, slug: `planner-org-${s}` },
  })
  const user = await prisma.user.create({
    data: {
      email: `planner-${s}@test.com`,
      name: 'Planner User',
      passwordHash: '$2a$12$placeholder',
    },
  })
  const other = await prisma.user.create({
    data: { email: `other-${s}@test.com`, name: 'Other User', passwordHash: '$2a$12$placeholder' },
  })
  await prisma.orgMember.createMany({
    data: [
      { userId: user.id, orgId: org.id, role: 'ADMIN' },
      { userId: other.id, orgId: org.id, role: 'MEMBER' },
    ],
  })
  const board = await prisma.board.create({ data: { name: `Board ${s}`, orgId: org.id } })
  const cols: Record<string, string> = {}
  for (const [name, position] of [
    ['Backlog', 0],
    ['In Progress', 1],
    ['Done', 2],
  ] as const) {
    const c = await prisma.column.create({ data: { name, position, boardId: board.id } })
    cols[name] = c.id
  }
  const mk = (data: Record<string, unknown>) =>
    prisma.card.create({
      data: { boardId: board.id, createdById: user.id, position: 0, ...data } as never,
    })
  const cards: Record<string, string> = {}
  cards.overdue = (
    await mk({
      title: 'Overdue deck',
      columnId: cols['In Progress'],
      assigneeId: user.id,
      priority: 'high',
      dueDate: new Date(NOW.getTime() - 2 * DAY),
    })
  ).id
  cards.plain = (
    await mk({
      title: 'Plain task',
      columnId: cols['Backlog'],
      assigneeId: user.id,
      priority: 'low',
    })
  ).id
  cards.review = (
    await mk({
      title: 'Review me',
      columnId: cols['In Progress'],
      assigneeId: other.id,
      reviewerId: user.id,
      priority: 'medium',
    })
  ).id
  cards.done = (
    await mk({
      title: 'Already done',
      columnId: cols['Done'],
      assigneeId: user.id,
      priority: 'critical',
    })
  ).id
  cards.foreign = (
    await mk({
      title: 'Not mine',
      columnId: cols['Backlog'],
      assigneeId: other.id,
      priority: 'critical',
    })
  ).id
  return { orgId: org.id, userId: user.id, otherUserId: other.id, boardId: board.id, cols, cards }
}

let current: Ctx | null = null

async function cleanup(ctx: Ctx) {
  await prisma.plannerDraft.deleteMany({ where: { userId: ctx.userId } })
  await prisma.plannerItem.deleteMany({ where: { userId: ctx.userId } })
  await prisma.plannerDay.deleteMany({ where: { userId: ctx.userId } })
  await prisma.organization.deleteMany({ where: { id: ctx.orgId } })
  await prisma.user.deleteMany({ where: { id: { in: [ctx.userId, ctx.otherUserId] } } })
}

async function getToday(refresh = false) {
  const { GET } = await import('../../src/app/api/planner/today/route')
  const res = await GET(
    jsonReq(
      `http://localhost/api/planner/today?date=${DATE}&tz=UTC${refresh ? '&refresh=1' : ''}`,
      'GET'
    )
  )
  const body = await res.json()
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200)
  return body as {
    items: Array<{
      id: string
      sourceKey: string
      section: string
      status: string
      payload: Record<string, unknown>
    }>
    counts: Record<string, number>
    sources: Record<string, string>
  }
}

async function patchItem(id: string, body: unknown) {
  const { PATCH } = await import('../../src/app/api/planner/items/[id]/route')
  const res = await PATCH(jsonReq(`http://localhost/api/planner/items/${id}`, 'PATCH', body), {
    params: Promise.resolve({ id }),
  })
  const json = await res.json()
  expect(res.status, JSON.stringify(json).slice(0, 300)).toBe(200)
  return json as {
    item: { status: string; section?: string }
    writeThrough: Array<Record<string, unknown>>
  }
}

describe('planner end-to-end (real SQLite)', () => {
  beforeAll(() => {
    // The planner tables ship via `db push` (no migration file); apply the schema to this test DB.
    execSync('npx prisma db push --skip-generate', { stdio: 'pipe', env: { ...process.env } })
  }, 120_000)

  afterEach(async () => {
    vi.clearAllMocks()
    delete process.env.INBOX_BOARD_ID
    delete process.env.INBOX_AGENT_OWNER
    if (current) {
      await cleanup(current)
      current = null
    }
  })

  it("collects the user's cards, ranks them, writes done through to the board, and keeps user decisions sticky", async () => {
    const ctx = await seed()
    current = ctx
    mockSession.userId = ctx.userId
    mockSession.orgId = ctx.orgId

    // 1. first load collects from the board; email/calendar/slack are not configured → skipped
    const first = await getToday()
    expect(first.sources).toEqual({
      card: 'ok',
      email: 'skipped',
      calendar: 'skipped',
      slack: 'skipped',
    })
    const keys = first.items.map((i) => i.sourceKey).sort()
    expect(keys).toEqual(
      [`card:${ctx.cards.overdue}`, `card:${ctx.cards.plain}`, `card:${ctx.cards.review}`].sort()
    )
    const overdueItem = first.items.find((i) => i.sourceKey === `card:${ctx.cards.overdue}`)!
    const reviewItem = first.items.find((i) => i.sourceKey === `card:${ctx.cards.review}`)!
    expect(overdueItem.section).toBe('now')
    expect(overdueItem.payload).toMatchObject({
      cardId: ctx.cards.overdue,
      boardId: ctx.boardId,
      role: 'assignee',
      columnName: 'In Progress',
    })
    expect(reviewItem.payload.role).toBe('reviewer')
    expect(first.counts.open).toBe(3)
    expect(first.counts.overdue).toBe(1)

    // 2. quick add a to-do
    const { POST } = await import('../../src/app/api/planner/items/route')
    const created = await POST(
      jsonReq('http://localhost/api/planner/items', 'POST', {
        title: 'Call the bank',
        priority: 'medium',
      })
    )
    expect(created.status).toBe(201)
    const manual = (await created.json()).item as { id: string }
    expect((await getToday()).items.map((i) => i.sourceKey)).toContain(
      (await prisma.plannerItem.findUniqueOrThrow({ where: { id: manual.id } })).sourceKey
    )

    // 3. done on the overdue assignee card moves the card to Done and records the movement
    const done = await patchItem(overdueItem.id, { action: 'done' })
    expect(done.item.status).toBe('done')
    expect(done.writeThrough).toEqual([
      {
        kind: 'card_moved',
        ok: true,
        cardId: ctx.cards.overdue,
        toColumnId: ctx.cols.Done,
        toColumnName: 'Done',
      },
    ])
    const moved = await prisma.card.findUniqueOrThrow({ where: { id: ctx.cards.overdue } })
    expect(moved.columnId).toBe(ctx.cols.Done)
    const movement = await prisma.cardMovement.findFirst({ where: { cardId: ctx.cards.overdue } })
    expect(movement).toMatchObject({
      fromColumnId: ctx.cols['In Progress'],
      toColumnId: ctx.cols.Done,
      movedById: ctx.userId,
      movedByKind: 'user',
    })

    // 4. done on a reviewer item does not touch the other person's card
    const reviewed = await patchItem(reviewItem.id, { action: 'done' })
    expect(reviewed.writeThrough).toEqual([{ kind: 'none', ok: true, reason: 'not_applicable' }])
    expect(
      (await prisma.card.findUniqueOrThrow({ where: { id: ctx.cards.review } })).columnId
    ).toBe(ctx.cols['In Progress'])

    // 5. re-collect: the moved card is no longer reported; both decisions stay done; nothing reopens
    const second = await getToday(true)
    const byKey = Object.fromEntries(second.items.map((i) => [i.sourceKey, i]))
    expect(byKey[`card:${ctx.cards.overdue}`].status).toBe('done')
    expect(byKey[`card:${ctx.cards.review}`].status).toBe('done')
    expect(byKey[`card:${ctx.cards.plain}`].status).toBe('open')
    expect(second.counts.doneToday).toBe(2)
    expect(second.counts.open).toBe(2) // plain card + the manual to-do

    // 6. snooze the to-do until tomorrow
    const snoozed = await patchItem(manual.id, {
      action: 'snooze',
      snoozedUntil: new Date(NOW.getTime() + DAY).toISOString(),
    })
    expect(snoozed.item.status).toBe('snoozed')
    expect((await getToday()).items.find((i) => i.id === manual.id)?.section).toBe('snoozed')

    // 7. a card left in Done on the board resolves its planner item as source-resolved on the next collect
    await prisma.card.update({ where: { id: ctx.cards.plain }, data: { columnId: ctx.cols.Done } })
    const third = await getToday(true)
    const plain = third.items.find((i) => i.sourceKey === `card:${ctx.cards.plain}`)!
    expect(plain.status).toBe('done')
    expect(
      (
        await prisma.plannerItem.findFirstOrThrow({
          where: { userId: ctx.userId, sourceKey: `card:${ctx.cards.plain}` },
        })
      ).resolvedBy
    ).toBe('source')
  })

  it('hands a draft off as a card comment', async () => {
    const ctx = await seed()
    current = ctx
    mockSession.userId = ctx.userId
    mockSession.orgId = ctx.orgId
    const today = await getToday()
    const item = today.items.find((i) => i.sourceKey === `card:${ctx.cards.plain}`)!

    const { POST: createDraft } = await import('../../src/app/api/planner/drafts/route')
    const created = await createDraft(
      jsonReq('http://localhost/api/planner/drafts', 'POST', {
        itemId: item.id,
        title: 'Status',
        body: 'Blocked on legal, ETA Friday.',
      })
    )
    expect(created.status).toBe(201)
    const draft = (await created.json()).draft as { id: string }

    const { POST: handoff } = await import('../../src/app/api/planner/drafts/[id]/handoff/route')
    const res = await handoff(
      jsonReq(`http://localhost/api/planner/drafts/${draft.id}/handoff`, 'POST', {
        kind: 'card_comment',
        cardId: ctx.cards.plain,
      }),
      { params: Promise.resolve({ id: draft.id }) }
    )
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.draft.status).toBe('handed_off')
    expect(body.handoff).toMatchObject({
      kind: 'card_comment',
      url: `/board/${ctx.boardId}?card=${ctx.cards.plain}`,
    })

    const comment = await prisma.comment.findFirst({ where: { cardId: ctx.cards.plain } })
    expect(comment?.content).toBe('**Status**\n\nBlocked on legal, ETA Friday.')
    expect(comment?.userId).toBe(ctx.userId)

    // a card in another org is invisible
    const foreignOrg = await prisma.organization.create({
      data: { name: 'x', slug: `x-${randomUUID().slice(0, 8)}` },
    })
    const fb = await prisma.board.create({ data: { name: 'fb', orgId: foreignOrg.id } })
    const fc = await prisma.column.create({
      data: { name: 'Backlog', position: 0, boardId: fb.id },
    })
    const fcard = await prisma.card.create({
      data: {
        title: 'foreign',
        boardId: fb.id,
        columnId: fc.id,
        createdById: ctx.otherUserId,
        position: 0,
      },
    })
    const res2 = await handoff(
      jsonReq(`http://localhost/api/planner/drafts/${draft.id}/handoff`, 'POST', {
        kind: 'card_comment',
        cardId: fcard.id,
      }),
      { params: Promise.resolve({ id: draft.id }) }
    )
    expect(res2.status).toBe(404)
    await prisma.organization.delete({ where: { id: foreignOrg.id } })
  })
})
