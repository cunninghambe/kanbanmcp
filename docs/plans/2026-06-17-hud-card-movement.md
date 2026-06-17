# HUD Card-Movement Awareness + Background-Error Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Host Meeting HUD card-movement awareness (a `CardMovement` audit trail surfaced via the board snapshot and a read-only MCP tool) and stop the HUD client from emitting silent background console errors.

**Architecture:** A new additive `CardMovement` table is written by a single `recordCardMovement()` helper invoked inside the existing transaction at all three column-change sites (UI/API PATCH, MCP `move_card`, ChangeSet apply). Read paths: a `formatRecentMovements()` section appended to `buildBoardContext`, and a read-only `list_card_movements` MCP tool. The HUD client is hardened: stream gated on a live session with bounded reconnects, dispatch failures surfaced, SWR retries capped on permanent errors.

**Tech Stack:** Next.js (App Router) · Prisma + SQLite · TypeScript · Vitest + Testing Library · SWR · EventSource (SSE).

**Spec:** `docs/specs/2026-06-17-hud-card-movement-and-console-hardening.md`

**Working tree:** isolated worktree `/root/kanban-hud-movement` on branch `feat/hud-card-movement`. Run all commands from there. `node_modules` is shared from the main checkout via the worktree; if imports fail, run `npm ci` once in the worktree.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `prisma/schema.prisma` | `CardMovement` model + back-relations | Modify |
| `src/lib/card-movement.ts` | `recordCardMovement` recorder + `formatRecentMovements` formatter + types | Create |
| `src/app/api/cards/[cardId]/route.ts` | Record movement on PATCH column change | Modify (~line 192-248) |
| `src/lib/mcp-server.ts` | Record movement in `toolMoveCard`; add `list_card_movements` tool | Modify |
| `src/lib/changesets.ts` | Record movement in `applyItem` `move_card` case | Modify (~line 161-169) |
| `src/lib/host-hud/worker.ts` | Append recent movements to `buildBoardContext` | Modify (~line 43-70) |
| `src/hooks/useHudStream.ts` | Bounded reconnect + `enabled` gating | Modify |
| `src/app/(app)/hud/[id]/page.tsx` | Surface dispatch errors; gate stream; cap SWR retries | Modify |
| `__tests__/lib/card-movement.test.ts` | Unit tests for recorder + formatter | Create |
| `__tests__/cards-api-movement.test.ts` | PATCH records movement | Create |
| `__tests__/mcp/move-card-movement.test.ts` | MCP move + `list_card_movements` | Create |
| `__tests__/lib/changesets-movement.test.ts` | ChangeSet apply records movement | Create |
| `__tests__/components/hud-session-page.test.tsx` | Dispatch error surfaced | Create |
| `__tests__/hooks/use-hud-stream.test.ts` | Bounded reconnect / enabled gating | Create |

**Test conventions (from the existing suite — follow exactly):**
- Tests live under `__tests__/`, named `*.test.ts(x)`. NOT colocated.
- Mock Prisma: `vi.mock('../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))`.
- Mock the session: `vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))`.
- `$transaction` mock: `mockPrisma.$transaction.mockImplementation(async (fn) => fn(txClient))`.
- Import the unit-under-test with dynamic `await import(...)` AFTER mocks are declared.
- Component tests start with `// @vitest-environment jsdom` and use `@testing-library/react`.

---

## Task 1: `CardMovement` schema + `recordCardMovement` recorder

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/lib/card-movement.ts`
- Test: `__tests__/lib/card-movement.test.ts`

- [ ] **Step 1: Add the model to the schema**

In `prisma/schema.prisma`, add this model (place it after the `Card` model's `@@map("cards")` block):

```prisma
model CardMovement {
  id           String   @id @default(cuid())
  cardId       String
  boardId      String
  orgId        String
  fromColumnId String?
  toColumnId   String
  movedById    String
  movedByKind  String   // "user" | "agent"
  movedAt      DateTime @default(now())

  card  Card  @relation(fields: [cardId], references: [id], onDelete: Cascade)
  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([cardId, movedAt])
  @@index([boardId, movedAt])
  @@index([orgId, movedAt])
  @@map("card_movements")
}
```

Add the back-relation line `movements   CardMovement[]` inside the `Card` model (in the relations block, near `comments Comment[]`) and `movements  CardMovement[]` inside the `Board` model (near its `columns`/`cards` relations).

- [ ] **Step 2: Regenerate the Prisma client and sync the test DB**

Run:
```bash
cd /root/kanban-hud-movement
npx prisma generate
DATABASE_URL='file:./kanban-test.db' npx prisma db push --skip-generate --accept-data-loss
```
Expected: `generate` prints "Generated Prisma Client"; `db push` prints "Your database is now in sync" (creates `card_movements`). The generated client now exposes `prisma.cardMovement`.

- [ ] **Step 3: Write the failing unit test for the recorder**

Create `__tests__/lib/card-movement.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('recordCardMovement', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes a row with from/to/actor when columns differ (positive)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'mv-1' })
    const tx = { cardMovement: { create } } as unknown as never
    const { recordCardMovement } = await import('../../src/lib/card-movement')

    const res = await recordCardMovement(tx, {
      cardId: 'card-1',
      boardId: 'board-1',
      orgId: 'org-1',
      fromColumnId: 'col-1',
      toColumnId: 'col-2',
      movedBy: { id: 'user-1', kind: 'user' },
    })

    expect(res).toEqual({ id: 'mv-1' })
    expect(create).toHaveBeenCalledWith({
      data: {
        cardId: 'card-1',
        boardId: 'board-1',
        orgId: 'org-1',
        fromColumnId: 'col-1',
        toColumnId: 'col-2',
        movedById: 'user-1',
        movedByKind: 'user',
      },
    })
  })

  it('no-ops and returns null when from === to (negative/boundary)', async () => {
    const create = vi.fn()
    const tx = { cardMovement: { create } } as unknown as never
    const { recordCardMovement } = await import('../../src/lib/card-movement')

    const res = await recordCardMovement(tx, {
      cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
      fromColumnId: 'col-1', toColumnId: 'col-1',
      movedBy: { id: 'user-1', kind: 'user' },
    })

    expect(res).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('accepts a null fromColumnId (edge)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'mv-2' })
    const tx = { cardMovement: { create } } as unknown as never
    const { recordCardMovement } = await import('../../src/lib/card-movement')

    const res = await recordCardMovement(tx, {
      cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
      fromColumnId: null, toColumnId: 'col-2',
      movedBy: { id: 'agent-x', kind: 'agent' },
    })

    expect(res).toEqual({ id: 'mv-2' })
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromColumnId: null, movedById: 'agent-x', movedByKind: 'agent' }),
    })
  })
})
```

- [ ] **Step 4: Run the test, verify it fails**

Run: `npx vitest run __tests__/lib/card-movement.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/card-movement'`.

- [ ] **Step 5: Implement the recorder**

Create `src/lib/card-movement.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client'

export type MovementActor = { id: string; kind: 'user' | 'agent' }

export type RecordCardMovementInput = {
  cardId: string
  boardId: string
  orgId: string
  fromColumnId: string | null
  toColumnId: string
  movedBy: MovementActor
}

/**
 * Records a single column change. No-ops (returns null) when fromColumnId === toColumnId,
 * so callers can call unconditionally. Must run inside the caller's transaction so the move
 * and its audit row commit atomically.
 */
export async function recordCardMovement(
  tx: Prisma.TransactionClient,
  input: RecordCardMovementInput
): Promise<{ id: string } | null> {
  if (input.fromColumnId === input.toColumnId) return null
  const row = await tx.cardMovement.create({
    data: {
      cardId: input.cardId,
      boardId: input.boardId,
      orgId: input.orgId,
      fromColumnId: input.fromColumnId,
      toColumnId: input.toColumnId,
      movedById: input.movedBy.id,
      movedByKind: input.movedBy.kind,
    },
    select: { id: true },
  })
  return row
}
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `npx vitest run __tests__/lib/card-movement.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma src/lib/card-movement.ts __tests__/lib/card-movement.test.ts
git commit -m "feat: add CardMovement model and recordCardMovement recorder"
```

---

## Task 2: Record movement on UI/API PATCH

**Files:**
- Modify: `src/app/api/cards/[cardId]/route.ts` (inside the `$transaction`, ~line 226-247)
- Test: `__tests__/cards-api-movement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/cards-api-movement.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }
vi.mock('iron-session', () => ({ getIronSession: vi.fn().mockResolvedValue(mockSession) }))

const recordCardMovement = vi.fn().mockResolvedValue({ id: 'mv-1' })
vi.mock('../src/lib/card-movement', () => ({ recordCardMovement }))

const mockPrisma = {
  card: { findUnique: vi.fn(), findMany: vi.fn() },
  orgMember: { findUnique: vi.fn() },
  label: { findMany: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock('../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('PATCH /api/cards/[cardId] movement recording', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
  })

  function txClient() {
    return {
      card: { update: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue({ position: 2 }) },
      cardLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
      cardMovement: { create: vi.fn() },
    }
  }

  it('records a movement when columnId changes (positive)', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', boardId: 'board-1', board: { orgId: 'org-1' }, column: { name: 'Backlog' } })
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-2', labels: [], comments: [] })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: ReturnType<typeof txClient>) => Promise<unknown>) => fn(txClient()))

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const res = await PATCH(makeRequest('http://localhost/api/cards/card-1', 'PATCH', { columnId: 'col-2' }), {
      params: Promise.resolve({ cardId: 'card-1' }),
    })

    expect(res.status).toBe(200)
    expect(recordCardMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
        fromColumnId: 'col-1', toColumnId: 'col-2',
        movedBy: { id: 'user-1', kind: 'user' },
      })
    )
  })

  it('does NOT record when only the title changes (negative)', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', boardId: 'board-1', board: { orgId: 'org-1' }, column: { name: 'Backlog' } })
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', labels: [], comments: [] })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: ReturnType<typeof txClient>) => Promise<unknown>) => fn(txClient()))

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const res = await PATCH(makeRequest('http://localhost/api/cards/card-1', 'PATCH', { title: 'Renamed' }), {
      params: Promise.resolve({ cardId: 'card-1' }),
    })

    expect(res.status).toBe(200)
    expect(recordCardMovement).not.toHaveBeenCalled()
  })

  it('does NOT record when columnId equals current column (boundary)', async () => {
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', boardId: 'board-1', board: { orgId: 'org-1' }, column: { name: 'Backlog' } })
      .mockResolvedValueOnce({ id: 'card-1', columnId: 'col-1', labels: [], comments: [] })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: ReturnType<typeof txClient>) => Promise<unknown>) => fn(txClient()))

    const { PATCH } = await import('../src/app/api/cards/[cardId]/route')
    const res = await PATCH(makeRequest('http://localhost/api/cards/card-1', 'PATCH', { columnId: 'col-1' }), {
      params: Promise.resolve({ cardId: 'card-1' }),
    })

    expect(res.status).toBe(200)
    expect(recordCardMovement).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run __tests__/cards-api-movement.test.ts`
Expected: FAIL — first test's `recordCardMovement` assertion fails (not yet called).

- [ ] **Step 3: Implement — call the recorder inside the transaction**

In `src/app/api/cards/[cardId]/route.ts`:

Add the import near the top (after line 7):
```ts
import { recordCardMovement } from '@/lib/card-movement'
```

Inside the `await prisma.$transaction(async (tx) => { ... })` block, AFTER the `if (Object.keys(updateData).length > 0) { await tx.card.update(...) }` (current line ~242-247), add:
```ts
      // Record a movement audit row when the card changed column.
      if (isChangingColumn) {
        await recordCardMovement(tx, {
          cardId: params.cardId,
          boardId: existingCard.boardId,
          orgId: session.orgId,
          fromColumnId: existingCard.columnId,
          toColumnId: columnId!,
          movedBy: { id: session.userId, kind: 'user' },
        })
      }
```
(`isChangingColumn`, `existingCard`, `columnId`, and `session` are all already in scope.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run __tests__/cards-api-movement.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the existing cards test to confirm no regression**

Run: `npx vitest run __tests__/cards-api.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cards/[cardId]/route.ts __tests__/cards-api-movement.test.ts
git commit -m "feat: record CardMovement on PATCH column change"
```

---

## Task 3: Record movement in the MCP `move_card` tool

**Files:**
- Modify: `src/lib/mcp-server.ts` (`toolMoveCard`, ~line 597-641)
- Test: `__tests__/mcp/move-card-movement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/mcp/move-card-movement.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const recordCardMovement = vi.fn().mockResolvedValue({ id: 'mv-1' })
vi.mock('../../src/lib/card-movement', () => ({ recordCardMovement }))
vi.mock('../../src/lib/agent-activity', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/lib/webhook', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined) }))

const mockPrisma = {
  card: { findFirst: vi.fn(), update: vi.fn() },
  column: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock('../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

const agentCtx = { orgId: 'org-1', agentName: 'AgentSmith', permissions: [] as string[] }

describe('MCP move_card movement recording', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records a movement with agent attribution (positive)', async () => {
    mockPrisma.card.findFirst.mockResolvedValue({ id: 'card-1', columnId: 'col-1', boardId: 'board-1' })
    mockPrisma.column.findFirst.mockResolvedValue({ id: 'col-2', boardId: 'board-1' })
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ card: { update: vi.fn().mockResolvedValue({ id: 'card-1', columnId: 'col-2' }) }, cardMovement: { create: vi.fn() } })
    )

    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const res = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'move_card', params: { cardId: 'card-1', columnId: 'col-2', position: 1 } },
      agentCtx
    )) as { result?: unknown; error?: unknown }

    expect(res.error).toBeUndefined()
    expect(recordCardMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
        fromColumnId: 'col-1', toColumnId: 'col-2',
        movedBy: { id: 'AgentSmith', kind: 'agent' },
      })
    )
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run __tests__/mcp/move-card-movement.test.ts`
Expected: FAIL — `recordCardMovement` not called.

- [ ] **Step 3: Implement — wrap update + record in a transaction**

In `src/lib/mcp-server.ts`:

Add the import near the top (after line 13):
```ts
import { recordCardMovement } from '@/lib/card-movement'
```

In `toolMoveCard`, replace the single update (current line 621-624):
```ts
  const card = await prisma.card.update({
    where: { id: cardId },
    data: { columnId, position },
  })
```
with:
```ts
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
```
(`existing` is already loaded above with `columnId`/`boardId`.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run __tests__/mcp/move-card-movement.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp-server.ts __tests__/mcp/move-card-movement.test.ts
git commit -m "feat: record CardMovement in MCP move_card tool"
```

---

## Task 4: Record movement in ChangeSet apply

**Files:**
- Modify: `src/lib/changesets.ts` (`applyItem`, `move_card` case, ~line 161-169)
- Test: `__tests__/lib/changesets-movement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/lib/changesets-movement.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const recordCardMovement = vi.fn().mockResolvedValue({ id: 'mv-1' })
vi.mock('../../src/lib/card-movement', () => ({ recordCardMovement }))

describe('applyChangeSet move_card movement recording', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records a movement attributed to the approving user (positive)', async () => {
    const tx = {
      card: { findFirst: vi.fn().mockResolvedValue({ id: 'card-1', columnId: 'col-1', boardId: 'board-1' }), update: vi.fn().mockResolvedValue({}) },
      column: { findFirst: vi.fn().mockResolvedValue({ id: 'col-2', boardId: 'board-1' }) },
      cardMovement: { create: vi.fn() },
    }
    const item = { id: 'item-1', op: 'move_card', payload: JSON.stringify({ cardId: 'card-1', columnId: 'col-2', position: 1 }), decision: 'pending' }
    const mockPrisma = {
      changeSet: { findFirst: vi.fn().mockResolvedValue({ id: 'cs-1', status: 'pending', items: [item] }), update: vi.fn() },
      changeItem: { update: vi.fn(), count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as Parameters<typeof import('../../src/lib/changesets').applyChangeSet>[0]

    const { applyChangeSet } = await import('../../src/lib/changesets')
    const res = await applyChangeSet(mockPrisma, 'cs-1', { orgId: 'org-1', userId: 'approver-1' })

    expect(res.ok).toBe(true)
    expect(recordCardMovement).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        cardId: 'card-1', boardId: 'board-1', orgId: 'org-1',
        fromColumnId: 'col-1', toColumnId: 'col-2',
        movedBy: { id: 'approver-1', kind: 'user' },
      })
    )
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run __tests__/lib/changesets-movement.test.ts`
Expected: FAIL — `recordCardMovement` not called.

- [ ] **Step 3: Implement — record in the `move_card` case**

In `src/lib/changesets.ts`:

Add the import after line 2:
```ts
import { recordCardMovement } from '@/lib/card-movement'
```

In `applyItem`, the `case 'move_card':` block (line 161-169), after the `await tx.card.update(...)` line, add:
```ts
      await recordCardMovement(tx, {
        cardId: p.cardId,
        boardId: existing.boardId,
        orgId,
        fromColumnId: existing.columnId,
        toColumnId: p.columnId,
        movedBy: { id: userId, kind: 'user' },
      })
```
(`existing` (with `columnId`/`boardId`), `orgId`, and `userId` are all parameters of `applyItem`.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run __tests__/lib/changesets-movement.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/changesets.ts __tests__/lib/changesets-movement.test.ts
git commit -m "feat: record CardMovement when an approved ChangeSet moves a card"
```

---

## Task 5: `formatRecentMovements` + inject into the board snapshot

**Files:**
- Modify: `src/lib/card-movement.ts` (add formatter)
- Modify: `src/lib/host-hud/worker.ts` (`buildBoardContext`, ~line 60-69)
- Test: append to `__tests__/lib/card-movement.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing file)**

Append to `__tests__/lib/card-movement.test.ts`:

```ts
describe('formatRecentMovements', () => {
  function prismaWith(movements: unknown[], columns: unknown[], users: unknown[], earliest: unknown) {
    return {
      cardMovement: {
        findMany: vi.fn().mockResolvedValue(movements),
        findFirst: vi.fn().mockResolvedValue(earliest),
      },
      column: { findMany: vi.fn().mockResolvedValue(columns) },
      user: { findMany: vi.fn().mockResolvedValue(users) },
    } as unknown as never
  }

  it('renders movement lines with column and actor names (positive)', async () => {
    const prisma = prismaWith(
      [{ cardId: 'c1', fromColumnId: 'col-1', toColumnId: 'col-2', movedById: 'user-1', movedByKind: 'user', movedAt: new Date('2026-06-14T10:00:00Z'), card: { title: 'Spoonworks' } }],
      [{ id: 'col-1', name: 'In Progress' }, { id: 'col-2', name: 'Review' }],
      [{ id: 'user-1', name: 'Brad' }],
      { movedAt: new Date('2026-06-10T00:00:00Z') }
    )
    const { formatRecentMovements } = await import('../../src/lib/card-movement')
    const out = await formatRecentMovements(prisma, { boardId: 'board-1', orgId: 'org-1', sinceDays: 14 })
    expect(out).toContain('Recent movements')
    expect(out).toContain('"Spoonworks": In Progress → Review on 2026-06-14 by Brad')
  })

  it('returns an empty string when there are no movements (boundary)', async () => {
    const prisma = prismaWith([], [], [], null)
    const { formatRecentMovements } = await import('../../src/lib/card-movement')
    const out = await formatRecentMovements(prisma, { boardId: 'board-1', orgId: 'org-1' })
    expect(out).toBe('')
  })

  it('appends a not-tracked note when the window predates the earliest record (edge)', async () => {
    const prisma = prismaWith(
      [{ cardId: 'c1', fromColumnId: 'col-1', toColumnId: 'col-2', movedById: 'AgentX', movedByKind: 'agent', movedAt: new Date('2026-06-16T10:00:00Z'), card: { title: 'X' } }],
      [{ id: 'col-1', name: 'A' }, { id: 'col-2', name: 'B' }],
      [],
      { movedAt: new Date('2026-06-16T09:00:00Z') }
    )
    const { formatRecentMovements } = await import('../../src/lib/card-movement')
    const out = await formatRecentMovements(prisma, { boardId: 'board-1', orgId: 'org-1', sinceDays: 30 })
    expect(out).toContain('not tracked')
    expect(out).toContain('by AgentX')
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run __tests__/lib/card-movement.test.ts`
Expected: FAIL — `formatRecentMovements` is not exported.

- [ ] **Step 3: Implement the formatter**

Append to `src/lib/card-movement.ts`:

```ts
const DAY_MS = 24 * 60 * 60 * 1000

export async function formatRecentMovements(
  prisma: PrismaClient,
  args: { boardId: string; orgId: string; sinceDays?: number; limit?: number }
): Promise<string> {
  const sinceDays = args.sinceDays ?? 14
  const limit = args.limit ?? 200
  const since = new Date(Date.now() - sinceDays * DAY_MS)

  const movements = await prisma.cardMovement.findMany({
    where: { boardId: args.boardId, orgId: args.orgId, movedAt: { gte: since } },
    orderBy: { movedAt: 'desc' },
    take: limit,
    include: { card: { select: { title: true } } },
  })
  if (movements.length === 0) return ''

  const columns = await prisma.column.findMany({
    where: { boardId: args.boardId },
    select: { id: true, name: true },
  })
  const colName = new Map(columns.map((c) => [c.id, c.name]))
  const column = (id: string | null) => (id ? (colName.get(id) ?? id) : '(new)')

  const userIds = [...new Set(movements.filter((m) => m.movedByKind === 'user').map((m) => m.movedById))]
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : []
  const userName = new Map(users.map((u) => [u.id, u.name ?? u.email]))
  const actor = (m: { movedById: string; movedByKind: string }) =>
    m.movedByKind === 'user' ? (userName.get(m.movedById) ?? m.movedById) : m.movedById

  const lines = [`Recent movements (last ${sinceDays} days):`]
  for (const m of movements) {
    const date = m.movedAt.toISOString().slice(0, 10)
    const title = m.card?.title ?? m.cardId
    lines.push(`  - "${title}": ${column(m.fromColumnId)} → ${column(m.toColumnId)} on ${date} by ${actor(m)}`)
  }

  const earliest = await prisma.cardMovement.findFirst({
    where: { boardId: args.boardId, orgId: args.orgId },
    orderBy: { movedAt: 'asc' },
    select: { movedAt: true },
  })
  if (earliest && since < earliest.movedAt) {
    lines.push(`  (movements before ${earliest.movedAt.toISOString().slice(0, 10)} are not tracked)`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run __tests__/lib/card-movement.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Inject into `buildBoardContext`**

In `src/lib/host-hud/worker.ts`:

Add the import near the top (after line 3):
```ts
import { formatRecentMovements } from '@/lib/card-movement'
```

In `buildBoardContext`, replace the final `return lines.join('\n')` (line 69) with:
```ts
  const movements = await formatRecentMovements(prisma, { boardId: board.id, orgId })
  const body = lines.join('\n')
  return movements ? `${body}\n\n${movements}` : body
```

- [ ] **Step 6: Run the host-hud worker tests to confirm no regression**

Run: `npx vitest run __tests__/lib/host-hud-dispatch.test.ts`
Expected: PASS (existing dispatch tests unaffected; `buildBoardContext` is internal).

- [ ] **Step 7: Commit**

```bash
git add src/lib/card-movement.ts src/lib/host-hud/worker.ts __tests__/lib/card-movement.test.ts
git commit -m "feat: surface recent card movements in the HUD board snapshot"
```

---

## Task 6: Read-only `list_card_movements` MCP tool

**Files:**
- Modify: `src/lib/mcp-server.ts` (add to `MCP_TOOLS`, `TOOL_HANDLERS`, implement handler)
- Test: append to `__tests__/mcp/move-card-movement.test.ts`

- [ ] **Step 1: Write the failing test (append)**

Append to `__tests__/mcp/move-card-movement.test.ts`:

```ts
describe('MCP list_card_movements', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a board\'s movements newest-first (positive)', async () => {
    mockPrisma.board = { findFirst: vi.fn().mockResolvedValue({ id: 'board-1' }) } as never
    mockPrisma.cardMovement = {
      findMany: vi.fn().mockResolvedValue([
        { id: 'mv-2', cardId: 'c1', boardId: 'board-1', fromColumnId: 'col-1', toColumnId: 'col-2', movedById: 'user-1', movedByKind: 'user', movedAt: new Date('2026-06-14T00:00:00Z'), card: { title: 'C1' } },
      ]),
    } as never
    mockPrisma.column = { findMany: vi.fn().mockResolvedValue([{ id: 'col-1', name: 'A' }, { id: 'col-2', name: 'B' }]) } as never

    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const res = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 9, method: 'list_card_movements', params: { boardId: 'board-1' } },
      agentCtx
    )) as { result?: { movements: unknown[]; truncated: boolean }; error?: unknown }

    expect(res.error).toBeUndefined()
    expect(res.result?.movements).toHaveLength(1)
    expect((res.result?.movements[0] as { fromColumn: string }).fromColumn).toBe('A')
  })

  it('rejects when neither boardId nor cardId is given (negative)', async () => {
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const res = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 10, method: 'list_card_movements', params: {} },
      agentCtx
    )) as { error?: { code: number } }
    expect(res.error?.code).toBe(-32602)
  })

  it('rejects a foreign-org board (IDOR boundary)', async () => {
    mockPrisma.board = { findFirst: vi.fn().mockResolvedValue(null) } as never
    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const res = (await handleMcpRequest(
      { jsonrpc: '2.0', id: 11, method: 'list_card_movements', params: { boardId: 'foreign' } },
      agentCtx
    )) as { error?: { code: number } }
    expect(res.error?.code).toBe(-32602)
  })
})
```
(Note: ensure `mockPrisma` at the top of this file also declares `board`, `cardMovement`, `column` keys initialised to `{}` so reassignment is typed; add them to the initial `mockPrisma` object.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run __tests__/mcp/move-card-movement.test.ts`
Expected: FAIL — `Method not found: list_card_movements`.

- [ ] **Step 3: Implement the tool**

In `src/lib/mcp-server.ts`:

(a) Add to the `MCP_TOOLS` array (after the `get_changeset` entry, before the closing `]`):
```ts
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
```

(b) Add the handler (near the other `toolXxx` functions, e.g. after `toolGetChangeset`):
```ts
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
    ? await prisma.column.findMany({ where: { boardId: { in: boardIds } }, select: { id: true, name: true } })
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
```

(c) Register it in `TOOL_HANDLERS` (after `get_changeset: toolGetChangeset,`):
```ts
  list_card_movements: toolListCardMovements,
```
It is read-only, so do NOT add it to `WRITE_TOOLS` (read tools are always permitted).

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run __tests__/mcp/move-card-movement.test.ts`
Expected: PASS (move + list tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp-server.ts __tests__/mcp/move-card-movement.test.ts
git commit -m "feat: add read-only list_card_movements MCP tool"
```

---

## Task 7: Reproduce the console errors in the live browser (investigation, no code)

**Goal:** Confirm which background source fires in the no-name state before changing client code. This task produces notes, not a commit.

- [ ] **Step 1: Open the live HUD and capture the console**

Using the camofox stealth browser, navigate to `http://5.161.200.212:3002`, log in as `brad@a1.dev` (password in the kanban DB / `/tmp/kanban-cookies.txt`), open `/hud`, and start / interact with a session. Mirror the user's report: avoid naming a session where possible, click a stock prompt, and watch the browser console + network panel.

Capture: the exact console error text and the failing request URL(s). camofox caveat: it suppresses uncaught `window.onerror`; rely on `console.error` capture and the network panel, and run a positive-control (deliberately hit a 404) to confirm capture works before trusting a clean read.

- [ ] **Step 2: Record findings**

Write a short note (in the PR description or a comment on the tasks) stating which of the three predicted sources fired (EventSource reconnect to a 404'd `/events`, swallowed dispatch POST failure, or SWR retry storm), with the captured evidence. Tasks 8-10 fix all three regardless; this confirms the primary one and AC9's repro.

---

## Task 8: Bound EventSource reconnects + gate on a live session

**Files:**
- Modify: `src/hooks/useHudStream.ts`
- Test: `__tests__/hooks/use-hud-stream.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/hooks/use-hud-stream.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('swr', () => ({ mutate: vi.fn() }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  url: string
  readyState = FakeEventSource.CONNECTING
  onerror: ((e: unknown) => void) | null = null
  onopen: ((e: unknown) => void) | null = null
  listeners: Record<string, ((e: unknown) => void)[]> = {}
  closed = false
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this) }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ||= []).push(fn) }
  removeEventListener() {}
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED }
  emitError() { this.readyState = FakeEventSource.CLOSED; this.onerror?.({}) }
}

beforeEach(() => {
  FakeEventSource.instances = []
  // @ts-expect-error test shim
  globalThis.EventSource = FakeEventSource
})

describe('useHudStream', () => {
  it('does not open a stream when disabled (no live session)', async () => {
    const { useHudStream } = await import('../../src/hooks/useHudStream')
    renderHook(() => useHudStream({ sessionId: 'hud-1', enabled: false }))
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('stops reconnecting after the error cap is reached', async () => {
    const { useHudStream } = await import('../../src/hooks/useHudStream')
    renderHook(() => useHudStream({ sessionId: 'hud-1', enabled: true }))
    const es = FakeEventSource.instances[0]
    expect(es).toBeTruthy()
    for (let i = 0; i < 6; i++) es.emitError()
    expect(es.closed).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run __tests__/hooks/use-hud-stream.test.ts`
Expected: FAIL — the current hook never calls `close()` on error (second test fails).

- [ ] **Step 3: Implement bounded reconnect + open-resets-counter**

Replace `src/hooks/useHudStream.ts` body with:

```ts
'use client'

import { useEffect, useRef } from 'react'
import { mutate } from 'swr'

interface UseHudStreamOptions {
  sessionId: string | null
  enabled?: boolean
}

const MAX_CONSECUTIVE_ERRORS = 5

/**
 * Opens an EventSource to /api/hud/[id]/events and revalidates the session's
 * dispatch SWR cache on each `dispatch_updated` event. Gated on `enabled` (caller
 * passes false until the session is confirmed to exist) and bounded: after
 * MAX_CONSECUTIVE_ERRORS reconnect failures without a successful open, it closes
 * and stops, so a 404/permanent failure can't spam the browser console.
 */
export function useHudStream({ sessionId, enabled = true }: UseHudStreamOptions) {
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!sessionId || !enabled) return

    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }

    const es = new EventSource(`/api/hud/${encodeURIComponent(sessionId)}/events`)
    esRef.current = es
    let errorCount = 0

    function handle() {
      mutate(`/api/hud/${sessionId}`)
    }

    es.addEventListener('dispatch_updated', handle)
    es.onopen = () => {
      errorCount = 0
    }
    es.onerror = () => {
      errorCount += 1
      if (errorCount >= MAX_CONSECUTIVE_ERRORS || es.readyState === EventSource.CLOSED) {
        es.close()
        if (esRef.current === es) esRef.current = null
      }
    }

    return () => {
      es.removeEventListener('dispatch_updated', handle)
      es.close()
      esRef.current = null
    }
  }, [sessionId, enabled])
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run __tests__/hooks/use-hud-stream.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useHudStream.ts __tests__/hooks/use-hud-stream.test.ts
git commit -m "fix: bound HUD EventSource reconnects and gate on enabled"
```

---

## Task 9: Surface dispatch failures + gate stream + cap SWR retries in the session page

**Files:**
- Modify: `src/app/(app)/hud/[id]/page.tsx`
- Test: `__tests__/components/hud-session-page.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `__tests__/components/hud-session-page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('swr', () => ({
  default: vi.fn(() => ({ data: { session: { id: 'h1', title: 'T', status: 'live', boardId: 'b1', startedAt: new Date().toISOString() }, dispatches: [] }, mutate: vi.fn() })),
}))
vi.mock('../../src/hooks/useHudStream', () => ({ useHudStream: vi.fn() }))
vi.mock('../../src/app/(app)/hud/_components/AgentConsole', () => ({
  AgentConsole: ({ onDispatch }: { onDispatch: (t: string, q: string) => void }) => (
    <button onClick={() => onDispatch('board', 'Which cards moved?')}>ask</button>
  ),
}))
vi.mock('../../src/app/(app)/hud/_components/DispatchCard', () => ({ DispatchCard: () => null }))
vi.mock('../../src/app/(app)/hud/_components/SituationRail', () => ({ SituationRail: () => null }))

describe('HUD session page dispatch error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }))
  })

  it('shows a user-visible error when a dispatch POST fails', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const Page = (await import('../../src/app/(app)/hud/[id]/page')).default
    render(<Page params={Promise.resolve({ id: 'h1' })} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'ask' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/boom|failed/i)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run __tests__/components/hud-session-page.test.tsx`
Expected: FAIL — no `alert` role is rendered (errors are swallowed).

- [ ] **Step 3: Implement — error state, gated stream, capped SWR**

In `src/app/(app)/hud/[id]/page.tsx`:

(a) Replace the three `useSWR` calls (lines 35-43) — add a no-retry-on-permanent config object and reuse it:
```ts
  const swrOpts = (refreshInterval: number) => ({
    refreshInterval,
    shouldRetryOnError: (err: Error) => !['403', '404'].includes(err.message),
  })
  const { data, mutate } = useSWR<{ session: HudSession; dispatches: Dispatch[] }>(`/api/hud/${id}`, fetcher, swrOpts(4000))
  const { data: pertinent } = useSWR(`/api/hud/${id}/pertinent`, fetcher, swrOpts(15000))
  const { data: changeData } = useSWR<{ changeSets: { id: string; status: string }[] }>(
    `/api/changesets?hudSessionId=${id}`,
    fetcher,
    swrOpts(5000)
  )
```
(The shared `fetcher` throws `new Error(String(r.status))`, so `err.message` is the status code.)

(b) Gate the stream on the session existing — change line 45:
```ts
  useHudStream({ sessionId: id, enabled: !!session })
```
(`session` is defined a few lines below as `data?.session`; move the `const session = data?.session` line above the `useHudStream` call.)

(c) Add an error state near the other `useState` hooks:
```ts
  const [dispatchError, setDispatchError] = useState<string | null>(null)
```

(d) Replace the `dispatch` function (lines 60-72) with one that surfaces failures:
```ts
  async function dispatch(target: Target, question: string) {
    setBusy(true)
    setDispatchError(null)
    try {
      const res = await fetch(`/api/hud/${id}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, question }),
      })
      if (res.ok) {
        mutate()
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setDispatchError(body.error ?? `Dispatch failed (${res.status})`)
      }
    } catch {
      setDispatchError('Dispatch failed — network error')
    } finally {
      setBusy(false)
    }
  }
```

(e) Render the error. Immediately after `<AgentConsole ... />` (line 134), add:
```tsx
          {dispatchError && (
            <div role="alert" className="km-mono" style={{ margin: '8px 0', fontSize: 11, color: 'var(--danger, #f87171)' }}>
              {dispatchError}
            </div>
          )}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run __tests__/components/hud-session-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/hud/[id]/page.tsx" __tests__/components/hud-session-page.test.tsx
git commit -m "fix: surface HUD dispatch failures, gate stream, cap SWR retries"
```

---

## Task 10: Full verification gate + deploy

**Files:** none (verification + deploy)

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors. (If `prisma.cardMovement` is unknown, re-run `npx prisma generate`.)

- [ ] **Step 2: Lint**

Run: `npx eslint . --max-warnings 0`
Expected: zero errors, zero warnings.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: all pass (existing suite + the new movement/stream/page tests).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds; route manifest lists `/hud` routes and the new code compiles.

- [ ] **Step 5: Browser verification of AC8/AC9**

With the build running locally (or after deploy), use camofox to confirm: (AC8) a forced dispatch failure shows the inline alert; (AC9) loading a non-live/missing session does not spam EventSource errors in the console. Record the result.

- [ ] **Step 6: Push the branch and open a PR**

```bash
git push -u origin feat/hud-card-movement
gh pr create --base claude/meeting-copilot-hud-x4o2zr --title "HUD card-movement audit log + background-error hardening" --body "Implements docs/specs/2026-06-17-hud-card-movement-and-console-hardening.md"
```

- [ ] **Step 7: Deploy to the live box (after review)**

On `/opt/kanban`, mirror the PR #33 deploy: check out the branch, `npx prisma generate`, `npm run build`, `pm2 restart kanban` (start.sh `db push`es `card_movements`). Confirm `/hud` 200, pm2 online, and the new table exists. Rollback = redeploy the prior branch.

---

## Self-Review

**Spec coverage:** Track 1 data model → Task 1; recorder → Task 1; three write sites → Tasks 2/3/4; snapshot injection → Task 5; MCP tool → Task 6. Track 2 repro → Task 7; EventSource → Task 8; dispatch surfacing + SWR retry → Task 9. Edge cases E1-E3 (Task 2), E4 (Task 3), E5 (Task 4), E7-E8 (Task 5), E9-E10 (Task 6), B1-B3 (Tasks 8/9). AC1-AC7 covered by Tasks 2-6 tests; AC8-AC9 by Tasks 9 + browser verification (Steps 7.5 / 10.5). E6 (cascade delete) and E11 (atomicity) are guaranteed structurally by `onDelete: Cascade` and running the recorder inside the caller's `$transaction` respectively — noted here rather than as separate tasks since they need no new code; add an integration assertion if desired.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the command and expected result.

**Type consistency:** `recordCardMovement(tx, RecordCardMovementInput)` and `MovementActor {id, kind}` used identically across Tasks 2/3/4; `formatRecentMovements(prisma, {boardId, orgId, sinceDays?, limit?})` consistent across Task 5 + tests; tool name `list_card_movements` consistent across Task 6 manifest, handler registration, and tests.
