/**
 * M1 Integration Tests — end-to-end pipeline across module boundaries.
 *
 * Coverage matrix:
 * ┌──────┬──────────────────────────────────────────────────────────────────┬──────────┐
 * │ ID   │ Test name                                                        │ Status   │
 * ├──────┼──────────────────────────────────────────────────────────────────┼──────────┤
 * │ AC-2 │ PATCH rejects assigneeId set to null                             │ this file│
 * │ AC-6 │ happy-path: parent → child → upload → AI review done → comment  │ this file│
 * │ AC-7 │ signoff role enforcement: non-reviewer → 403                     │ signoffs │
 * │ AC-8 │ GET /children depth bounding                                     │ children │
 * │ AC-9 │ reparent cycle detection                                         │ reparent │
 * │AC-10 │ depth-50 cap                                                     │ create   │
 * │AC-11 │ aiReviewParams inheritance: child null, parent set               │ inherit  │
 * │AC-12 │ inheritance walker terminates at 50                              │ inherit  │
 * │AC-13 │ MCP create_subcard sets parentCardId / path / depth             │ mcp tools│
 * │AC-14 │ MCP list_card_tree shape matches HTTP /children                  │ mcp tools│
 * │  E1  │ parent delete → children become roots (eager recompute)          │ delete   │
 * │  E2  │ reparent → subtree path recomputed inside transaction            │ reparent │
 * │  E3  │ cycle attempt → 400                                              │ reparent │
 * │  E4  │ depth > 50 → 400                                                 │ create   │
 * │  E6  │ reviewer attempting APPROVER role → 403                          │ signoffs │
 * │  E7  │ aiAutoReview toggled after upload → no auto-review               │ pipeline │
 * │  E8  │ no params anywhere + no env → AiReview status=failed             │ pipeline │
 * │  E9  │ AI call rate-limit → retry 3x → fail                            │ client   │
 * │ E10  │ image > 5 MB → status=skipped                                    │ pipeline │
 * │ E11  │ artifact > 25 MB → 413                                           │ upload   │
 * │ E12  │ PDF empty text fallback                                           │ extract  │
 * │ E13  │ concurrent uploads → multiple AiReview rows                      │ pipeline │
 * │ E14  │ artifact deleted mid-review → AiReview done, no comment          │ pipeline │
 * │ E15  │ signoff with no role assigned → 400                              │ signoffs │
 * │ E16  │ aiReviewParams inheritance with intermediate null                 │ inherit  │
 * │  —   │ AC-1 schema migration: manual smoke only                         │ manual   │
 * │  —   │ AC-3 seed idempotency                                            │ seed     │
 * │  —   │ AC-4 POST without assigneeId → 400                               │ create   │
 * │  —   │ AC-5 artifact upload + storage                                   │ upload   │
 * │  —   │ E5  former member "(former member)" label: manual QA only        │ manual   │
 * └──────┴──────────────────────────────────────────────────────────────────┴──────────┘
 *
 * Tests unique to this file:
 *  1. AC-2: PATCH /api/cards/[cardId] — Zod rejects assigneeId: null
 *  2. End-to-end happy path: create parent → create child (subcard) → upload artifact
 *     with aiAutoReview=true → AI worker runs (mocked Claude) → comment posted →
 *     reviewer submits APPROVED signoff → tree query returns both cards with signoff
 *
 * All external services mocked at the boundary:
 *   - @anthropic-ai/sdk — no real API calls
 *   - lib/storage — in-memory stub
 *   - iron-session — hardcoded session
 *   - lib/db (prisma) — vi.fn() stubs per test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock @anthropic-ai/sdk ──────────────────────────────────────────────────
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {},
  RateLimitError: class extends Error { status = 429 },
  APIError: class extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))

// ─── Mock pdf-parse ───────────────────────────────────────────────────────────
vi.mock('pdf-parse', () => ({
  PDFParse: vi.fn(() => ({
    getText: vi.fn().mockResolvedValue({ text: '' }),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}))

// ─── Mock iron-session ────────────────────────────────────────────────────────
const mockSession = { userId: 'user-1', orgId: 'org-1', save: vi.fn() }

vi.mock('iron-session', () => ({
  getIronSession: vi.fn().mockResolvedValue(mockSession),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockReturnValue({}),
}))

// ─── Mock storage ─────────────────────────────────────────────────────────────
const mockStorage = { put: vi.fn(), getStream: vi.fn(), delete: vi.fn() }
vi.mock('../../src/lib/storage', () => ({ getStorageDriver: () => mockStorage }))

// ─── Mock seed-ai-reviewer ────────────────────────────────────────────────────
vi.mock('../../prisma/seed-ai-reviewer', () => ({
  AI_REVIEWER_EMAIL: 'ai-reviewer@kanbanmcp.local',
  AI_REVIEWER_NAME: 'AI Reviewer',
  ensureAiReviewerUser: vi.fn().mockResolvedValue({ id: 'reviewer-bot', email: 'ai-reviewer@kanbanmcp.local' }),
}))

// ─── Mock prisma ─────────────────────────────────────────────────────────────
// The factory must NOT reference external variables (vi.mock is hoisted).
// We create the mock object inside the factory and expose it via a module
// property, following the same pattern as ai-review-pipeline.test.ts.
vi.mock('../../src/lib/db', () => {
  const p = {
    board: { findUnique: vi.fn() },
    card: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    column: { findUnique: vi.fn() },
    orgMember: { findUnique: vi.fn(), findMany: vi.fn() },
    artifact: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    aiReview: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    comment: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    signoff: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
    apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  }
  return { prisma: p, default: p }
})

// ─── Import prisma mock reference + AI worker after mocks ───────────────────
import { prisma } from '../../src/lib/db'
import {
  enqueueAiReview,
  flushForTests,
  __setClaudeClientForTests,
  resetQueueForTests,
} from '../../src/lib/ai-review/worker'

// Cast to typed mock object for test-side access.
const mockPrisma = prisma as unknown as {
  board: { findUnique: ReturnType<typeof vi.fn> }
  card: {
    findUnique: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  column: { findUnique: ReturnType<typeof vi.fn> }
  orgMember: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
  artifact: {
    findUnique: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
  aiReview: {
    create: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  comment: { create: ReturnType<typeof vi.fn> }
  user: { findUnique: ReturnType<typeof vi.fn> }
  signoff: {
    create: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
  }
  $transaction: ReturnType<typeof vi.fn>
  apiKey: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
}

// ─── Shared fixtures ─────────────────────────────────────────────────────────

function makeJsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeFormDataRequest(url: string, file: File): NextRequest {
  const fd = new FormData()
  fd.append('file', file)
  return new NextRequest(url, { method: 'POST', body: fd })
}

function makeFile(name: string, type: string, sizeBytes: number): File {
  const content = new Uint8Array(sizeBytes).fill(65)
  return new File([content], name, { type })
}

function makeStream(content: string) {
  const { Readable } = require('node:stream')
  const stream = new Readable({ read() {} })
  stream.push(Buffer.from(content, 'utf-8'))
  stream.push(null)
  return stream
}

const PARENT_CARD = {
  id: 'parent-card',
  title: 'Parent Task',
  boardId: 'board-1',
  columnId: 'col-1',
  parentCardId: null,
  path: '',
  depth: 0,
  aiAutoReview: true,
  aiReviewParams: JSON.stringify({ model: 'claude-opus-4-7', rubric: 'review code quality' }),
  reviewerId: 'user-reviewer',
  approverId: null,
  assigneeId: 'user-1',
  board: { orgId: 'org-1' },
  assignee: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
  reviewer: { id: 'user-reviewer', name: 'Bob', email: 'bob@example.com' },
  approver: null,
}

const CHILD_CARD = {
  id: 'child-card',
  title: 'Sub-task',
  boardId: 'board-1',
  columnId: 'col-1',
  parentCardId: 'parent-card',
  path: '/parent-card/',
  depth: 1,
  aiAutoReview: false,
  aiReviewParams: null,
  reviewerId: null,
  approverId: null,
  assigneeId: 'user-1',
  board: { orgId: 'org-1' },
  assignee: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
  reviewer: null,
  approver: null,
}

const ARTIFACT = {
  id: 'artifact-1',
  cardId: 'parent-card',
  uploaderId: 'user-1',
  filename: 'spec.md',
  mimeType: 'text/markdown',
  sizeBytes: 200,
  storageKey: 'artifact-1',
  source: 'UPLOAD',
  createdAt: new Date(),
  uploader: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
  reviews: [],
}

const REVIEW_ROW = {
  id: 'review-1',
  artifactId: 'artifact-1',
  status: 'pending',
  model: 'claude-opus-4-7',
  rubricSnapshot: 'review code quality',
  instructions: null,
  output: null,
  errorMessage: null,
  inputTokens: null,
  outputTokens: null,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(),
  artifact: {
    id: 'artifact-1',
    cardId: 'parent-card',
    filename: 'spec.md',
    mimeType: 'text/markdown',
    storageKey: 'artifact-1',
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: PATCH /api/cards/[cardId] — Zod rejects assigneeId: null
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-2: PATCH /api/cards/[cardId] — assigneeId cannot be set to null', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = 'user-1'
    mockSession.orgId = 'org-1'
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockPrisma.card.findUnique.mockResolvedValue(PARENT_CARD)
  })

  it('AC-2: PATCH with assigneeId: null returns 400 (schema enforces non-null)', async () => {
    // Given: an existing card with assigneeId set
    // When: client sends PATCH { assigneeId: null }
    // Then: 400, Zod rejects because assigneeId is z.string().min(1).optional() — not nullable

    const { PATCH } = await import('../../src/app/api/cards/[cardId]/route')
    const req = makeJsonRequest('http://localhost/api/cards/parent-card', 'PATCH', {
      assigneeId: null,
    })
    const res = await PATCH(req, { params: { cardId: 'parent-card' } })

    expect(res.status).toBe(400)
    const body = await res.json()
    // The schema uses z.string().min(1).optional() — null triggers a Zod validation error
    expect(body.error || body.issues).toBeTruthy()
  })

  it('AC-2: PATCH with assigneeId: empty string returns 400', async () => {
    // Given: existing card
    // When: client sends { assigneeId: "" }
    // Then: 400 — z.string().min(1) rejects empty string

    const { PATCH } = await import('../../src/app/api/cards/[cardId]/route')
    const req = makeJsonRequest('http://localhost/api/cards/parent-card', 'PATCH', {
      assigneeId: '',
    })
    const res = await PATCH(req, { params: { cardId: 'parent-card' } })

    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: End-to-end happy path across module boundaries
//
// Steps:
//   1. POST /api/boards/board-1/cards → creates parent card
//   2. POST /api/boards/board-1/cards (with parentCardId) → creates child card
//   3. POST /api/cards/parent-card/artifacts (aiAutoReview=true) →
//        artifact stored + AI review enqueued
//   4. flushForTests() — AI worker runs (mocked Claude) → status=done, comment posted
//   5. POST /api/cards/parent-card/signoffs → reviewer submits APPROVED
//   6. GET /api/cards/parent-card/children → tree includes child, signoff visible
//
// This is the "happy path" integration test that validates the pipeline
// crosses multiple modules (card API → artifact API → AI worker → signoff API
// → children API) as a composed unit.
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-6: end-to-end M1 pipeline (create parent → child → upload → review → signoff → tree)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetQueueForTests()
    mockSession.userId = 'user-1'
    mockSession.orgId = 'org-1'

    // Default storage stub
    mockStorage.put.mockResolvedValue({ key: 'artifact-1' })
    mockStorage.getStream.mockImplementation(async () => makeStream('# spec content'))

    // Reviewer user lookup by worker
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'reviewer-bot', email: 'ai-reviewer@kanbanmcp.local' })

    // AI review comment
    mockPrisma.comment.create.mockResolvedValue({ id: 'comment-1' })

    __setClaudeClientForTests(null)
  })

  it('AC-6: full pipeline — upload triggers review, review posts comment (mocked Claude)', async () => {
    // ── Step 1: POST parent card ──────────────────────────────────────────────
    // Given: board org-1, org member user-1
    mockPrisma.board.findUnique.mockResolvedValue({ id: 'board-1', orgId: 'org-1' })
    mockPrisma.orgMember.findUnique.mockResolvedValue({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })
    mockPrisma.orgMember.findMany.mockResolvedValue([{ userId: 'user-1' }])
    mockPrisma.column.findUnique.mockResolvedValue({ id: 'col-1', boardId: 'board-1' })
    mockPrisma.card.findFirst.mockResolvedValue(null)
    mockPrisma.card.findUnique.mockResolvedValue(null) // no existing parent
    mockPrisma.card.create.mockResolvedValueOnce({
      ...PARENT_CARD,
      createdBy: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
    })

    const { POST: postCard } = await import('../../src/app/api/boards/[boardId]/cards/route')
    const createParentReq = makeJsonRequest('http://localhost/api/boards/board-1/cards', 'POST', {
      title: 'Parent Task',
      columnId: 'col-1',
      assigneeId: 'user-1',
      reviewerId: 'user-1',
      aiAutoReview: true,
      aiReviewParams: { model: 'claude-opus-4-7', rubric: 'review code quality' },
    })
    const parentRes = await postCard(createParentReq, { params: { boardId: 'board-1' } })

    // Then: parent card created
    expect(parentRes.status).toBe(201)
    const parentBody = await parentRes.json()
    expect(parentBody.card.id).toBe('parent-card')
    expect(parentBody.card.aiAutoReview).toBe(true)

    // ── Step 2: POST child card (subcard) ─────────────────────────────────────
    // Given: parent card exists at depth=0
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'parent-card', boardId: 'board-1', path: '', depth: 0,
    })
    mockPrisma.card.create.mockResolvedValueOnce({
      ...CHILD_CARD,
      createdBy: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
    })

    const createChildReq = makeJsonRequest('http://localhost/api/boards/board-1/cards', 'POST', {
      title: 'Sub-task',
      columnId: 'col-1',
      assigneeId: 'user-1',
      parentCardId: 'parent-card',
    })
    const childRes = await postCard(createChildReq, { params: { boardId: 'board-1' } })

    // Then: child has correct parentCardId, path, depth
    expect(childRes.status).toBe(201)
    const childBody = await childRes.json()
    expect(childBody.card.parentCardId).toBe('parent-card')
    expect(childBody.card.path).toBe('/parent-card/')
    expect(childBody.card.depth).toBe(1)

    // ── Step 3: POST artifact with aiAutoReview=true ──────────────────────────
    // Given: parent card with aiAutoReview=true
    mockPrisma.card.findUnique
      .mockResolvedValueOnce({ id: 'parent-card', aiAutoReview: true, board: { orgId: 'org-1' } })
      .mockResolvedValueOnce({ id: 'parent-card', aiAutoReview: true, board: { orgId: 'org-1' } })
    mockPrisma.artifact.create.mockResolvedValueOnce({ ...ARTIFACT, storageKey: 'pending' })
    mockPrisma.artifact.update.mockResolvedValueOnce(ARTIFACT)

    // AI review: enqueue + create pending row
    mockPrisma.artifact.findUnique.mockResolvedValue({
      id: 'artifact-1',
      cardId: 'parent-card',
      filename: 'spec.md',
      mimeType: 'text/markdown',
      storageKey: 'artifact-1',
    })
    mockPrisma.card.findUnique.mockResolvedValue(PARENT_CARD)
    mockPrisma.aiReview.create.mockResolvedValueOnce(REVIEW_ROW)
    mockPrisma.aiReview.findUnique.mockResolvedValueOnce(REVIEW_ROW)
    mockPrisma.aiReview.update.mockResolvedValue({ ...REVIEW_ROW, status: 'done' })

    // Mock Claude to return a deterministic review
    __setClaudeClientForTests(async () => ({
      output: 'Code quality is acceptable. Suggest adding error handling.',
      inputTokens: 120,
      outputTokens: 30,
    }))

    // Mock the enqueueAiReview integration: wire artifact upload → worker
    // The upload route imports from '../../src/lib/ai-review/queue' which re-exports from worker.
    // Since both use the same module instance in tests, enqueueAiReview from upload
    // feeds into flushForTests().

    const { POST: postArtifact } = await import('../../src/app/api/cards/[cardId]/artifacts/route')
    const uploadReq = makeFormDataRequest(
      'http://localhost/api/cards/parent-card/artifacts',
      makeFile('spec.md', 'text/markdown', 200)
    )

    // Note: the artifact route mocks requireSession/requireOrgRole via api-helpers.
    // We need those to resolve. In this file we mock iron-session directly.
    const uploadRes = await postArtifact(uploadReq, { params: { cardId: 'parent-card' } })

    // Then: artifact created (201) with correct shape
    expect(uploadRes.status).toBe(201)
    const uploadBody = await uploadRes.json()
    expect(uploadBody.artifact.id).toBe('artifact-1')
    expect(uploadBody.artifact.filename).toBe('spec.md')
    expect(uploadBody.artifact.mimeType).toBe('text/markdown')
    expect(uploadBody.artifact.uploader.id).toBe('user-1')

    // ── Step 4: flushForTests — AI worker processes the job ───────────────────
    // When: worker drains the queue (deterministic via flushForTests)
    await flushForTests()

    // Then: AiReview transitioned running → done
    const updateCalls = mockPrisma.aiReview.update.mock.calls as Array<[{ data: { status: string; output?: string } }]>
    const runningCall = updateCalls.find((c) => c[0].data.status === 'running')
    const doneCall = updateCalls.find((c) => c[0].data.status === 'done')
    expect(runningCall).toBeDefined() // AC-6: status transitions running
    expect(doneCall).toBeDefined()    // AC-6: status transitions done
    expect(doneCall![0].data.output).toContain('error handling')

    // Then: comment posted by AI Reviewer user
    expect(mockPrisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cardId: 'parent-card',
          userId: 'reviewer-bot',
          content: expect.stringContaining('**AI review of spec.md:**'),
        }),
      })
    )

    // ── Step 5: POST signoff — reviewer submits APPROVED ─────────────────────
    // Given: card with reviewer set; session is user-reviewer
    mockSession.userId = 'user-reviewer'
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      id: 'parent-card',
      board: { orgId: 'org-1' },
      reviewerId: 'user-reviewer',
      approverId: null,
    })
    mockPrisma.orgMember.findUnique.mockResolvedValueOnce({ userId: 'user-reviewer', orgId: 'org-1', role: 'MEMBER' })
    const createdSignoff = {
      id: 'signoff-1',
      cardId: 'parent-card',
      userId: 'user-reviewer',
      role: 'REVIEWER',
      decision: 'APPROVED',
      comment: 'LGTM',
      createdAt: new Date(),
      user: { id: 'user-reviewer', name: 'Bob', email: 'bob@example.com' },
    }
    mockPrisma.signoff.create.mockResolvedValueOnce(createdSignoff)

    const { POST: postSignoff } = await import('../../src/app/api/cards/[cardId]/signoffs/route')
    const signoffReq = makeJsonRequest('http://localhost/api/cards/parent-card/signoffs', 'POST', {
      role: 'REVIEWER',
      decision: 'APPROVED',
      comment: 'LGTM',
    })
    const signoffRes = await postSignoff(signoffReq, { params: { cardId: 'parent-card' } })

    // Then: signoff created successfully
    expect(signoffRes.status).toBe(201)
    const signoffBody = await signoffRes.json()
    expect(signoffBody.signoff.role).toBe('REVIEWER')
    expect(signoffBody.signoff.decision).toBe('APPROVED')

    // ── Step 6: GET /children — tree returns parent with child ───────────────
    // Given: parent card with child
    mockSession.userId = 'user-1'
    mockPrisma.card.findUnique.mockResolvedValueOnce({
      ...PARENT_CARD,
    })
    mockPrisma.card.findMany.mockResolvedValueOnce([CHILD_CARD])
    mockPrisma.signoff.findMany.mockResolvedValueOnce([createdSignoff])
    mockPrisma.orgMember.findUnique.mockResolvedValueOnce({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })

    const { GET: getChildren } = await import('../../src/app/api/cards/[cardId]/children/route')
    const childrenReq = new NextRequest(
      'http://localhost/api/cards/parent-card/children?depth=1',
      { method: 'GET' }
    )
    const childrenRes = await getChildren(childrenReq, { params: { cardId: 'parent-card' } })

    // Then: tree includes parent and child; parent has APPROVED signoff
    expect(childrenRes.status).toBe(200)
    const childrenBody = await childrenRes.json()
    expect(childrenBody.root.id).toBe('parent-card')
    expect(childrenBody.descendants).toHaveLength(1)
    expect(childrenBody.descendants[0].id).toBe('child-card')
    expect(childrenBody.descendants[0].depth).toBe(1)
    // Parent's reviewer signoff is APPROVED
    expect(childrenBody.root.signoffs.reviewer).toMatchObject({
      id: 'signoff-1',
      decision: 'APPROVED',
    })
  })

  it('AC-14: MCP list_card_tree shape matches GET /api/cards/[cardId]/children (cross-module)', async () => {
    // Given: same data served via two different access paths (HTTP route + MCP tool)
    // When: both are called with the same cardId
    // Then: root and descendants shape must be equivalent

    // ── HTTP /children response ───────────────────────────────────────────────
    mockPrisma.card.findUnique.mockResolvedValueOnce(PARENT_CARD)
    mockPrisma.card.findMany.mockResolvedValueOnce([CHILD_CARD])
    mockPrisma.signoff.findMany.mockResolvedValueOnce([])
    mockPrisma.orgMember.findUnique.mockResolvedValueOnce({ userId: 'user-1', orgId: 'org-1', role: 'MEMBER' })

    const { GET: getChildren } = await import('../../src/app/api/cards/[cardId]/children/route')
    const httpReq = new NextRequest('http://localhost/api/cards/parent-card/children?depth=1', { method: 'GET' })
    const httpRes = await getChildren(httpReq, { params: { cardId: 'parent-card' } })
    expect(httpRes.status).toBe(200)
    const httpBody = await httpRes.json()

    // ── MCP list_card_tree response ───────────────────────────────────────────
    mockPrisma.card.findFirst.mockResolvedValueOnce({ id: 'parent-card', boardId: 'board-1' })
    mockPrisma.card.findUnique.mockResolvedValueOnce(PARENT_CARD)
    mockPrisma.card.findMany.mockResolvedValueOnce([CHILD_CARD])
    mockPrisma.signoff.findMany.mockResolvedValueOnce([])

    const { handleMcpRequest } = await import('../../src/lib/mcp-server')
    const mcpResult = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'list_card_tree', params: { cardId: 'parent-card', depth: 1 } },
      { orgId: 'org-1', agentName: 'test-agent', keyId: 'key-1', permissions: ['*'] }
    ) as { result: { root: { id: string }; descendants: Array<{ id: string }> } }

    // Then: both paths expose the same root id and descendant ids
    expect(mcpResult.result.root.id).toBe(httpBody.root.id)
    expect(mcpResult.result.descendants).toHaveLength(httpBody.descendants.length)
    if (httpBody.descendants.length > 0) {
      expect(mcpResult.result.descendants[0].id).toBe(httpBody.descendants[0].id)
    }
  })
})
