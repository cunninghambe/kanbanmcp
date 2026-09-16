/**
 * Email source (spec §4.5 email.ts): inbox-agent cards + pending nudges, gated
 * by the mailbox-owner allowlist (fail closed). (WI-1)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  card: { findMany: vi.fn() },
  nudge: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
}))
vi.mock('../../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

import { readEmail } from '../../../src/lib/planner/sources/email'
import type { SourceContext } from '../../../src/lib/planner/types'
import { dayBounds } from '../../../src/lib/planner/time'

const NOW = new Date('2026-09-16T09:00:00Z')
const CTX: SourceContext = {
  userId: 'user-1',
  orgId: 'org-1',
  tz: 'UTC',
  now: NOW,
  window: dayBounds('2026-09-16', 'UTC'),
}

const REAL = '`gmail:realthread123`'
function description(lines: string[]) {
  return lines.join('\n')
}

function inboxCard(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    title: '✉️ Reply to Jane about the invoice',
    description: description([
      '**Invoice question**',
      'From: Jane Doe <jane@example.com>',
      '⏰ Deadline: 2026-09-20',
      'Suggested: Reply with availability.',
      '[Open in Gmail](https://mail.google.com/mail/u/0/#inbox/realthread123)',
      REAL,
    ]),
    boardId: 'inbox-board',
    columnId: 'col-triage',
    priority: 'medium',
    dueDate: new Date('2026-09-20T00:00:00Z'),
    column: { id: 'col-triage', name: 'Triage' },
    ...over,
  }
}

describe('planner/sources/email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('INBOX_BOARD_ID', 'inbox-board')
    vi.stubEnv('INBOX_AGENT_OWNER', 'owner@example.com')
    mockPrisma.user.findUnique.mockResolvedValue({ email: 'Owner@Example.com' })
    mockPrisma.card.findMany.mockResolvedValue([])
    mockPrisma.nudge.findMany.mockResolvedValue([])
  })

  it('returns null (skipped) when INBOX_BOARD_ID is unset, without querying', async () => {
    vi.stubEnv('INBOX_BOARD_ID', '')
    expect(await readEmail(CTX)).toBeNull()
    expect(mockPrisma.card.findMany).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED: returns null when INBOX_AGENT_OWNER is unset, even for a configured board', async () => {
    vi.stubEnv('INBOX_AGENT_OWNER', '')
    expect(await readEmail(CTX)).toBeNull()
    expect(mockPrisma.card.findMany).not.toHaveBeenCalled()
  })

  it('returns null for a user who is not the mailbox owner', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ email: 'someone-else@example.com' })
    expect(await readEmail(CTX)).toBeNull()
    expect(mockPrisma.card.findMany).not.toHaveBeenCalled()
  })

  it('reads the inbox board for the owner, scoped to the org, with resolveMissing "all"', async () => {
    const read = await readEmail(CTX)
    expect(read).not.toBeNull()
    expect(read!.resolveMissing).toBe('all')
    const where = mockPrisma.card.findMany.mock.calls[0][0].where
    expect(where.boardId).toBe('inbox-board')
    expect(where.board).toEqual({ orgId: 'org-1' })
    expect(mockPrisma.nudge.findMany.mock.calls[0][0].where).toEqual({
      orgId: 'org-1',
      status: 'pending',
    })
  })

  it('maps a triage card: marker stripped from the title, sender summary, Gmail permalink, anchored thread id', async () => {
    mockPrisma.card.findMany.mockResolvedValue([inboxCard()])
    const [item] = (await readEmail(CTX))!.items
    expect(item).toEqual({
      sourceKey: 'email:e1',
      title: 'Reply to Jane about the invoice',
      summary: 'Jane Doe <jane@example.com>',
      url: 'https://mail.google.com/mail/u/0/#inbox/realthread123',
      priority: 'medium',
      dueAt: new Date('2026-09-20T00:00:00Z'),
      payload: {
        cardId: 'e1',
        boardId: 'inbox-board',
        columnName: 'Triage',
        gmailThreadId: 'realthread123',
        from: 'Jane Doe <jane@example.com>',
        permalink: 'https://mail.google.com/mail/u/0/#inbox/realthread123',
        nudgeId: null,
        urgent: false,
      },
    })
  })

  it('ignores a gmail: string smuggled into the subject (PR #38 attack) — only the anchored marker line binds', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      inboxCard({
        description: description([
          '**Invoice question gmail:attackerthread999**',
          'From: attacker@evil.test',
          'Suggested: reply. gmail:attackerthread999',
          '[Open in Gmail](https://mail.google.com/mail/u/0/#inbox/realthread123)',
          REAL,
        ]),
      }),
    ])
    const [item] = (await readEmail(CTX))!.items
    expect(item.payload.gmailThreadId).toBe('realthread123')
  })

  it('has no thread id when the marker is missing', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      inboxCard({ description: 'From: a@b.c\nno marker here' }),
    ])
    const [item] = (await readEmail(CTX))!.items
    expect(item.payload.gmailThreadId).toBeNull()
  })

  it('only accepts a permalink on mail.google.com', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      inboxCard({
        id: 'e1',
        description: description(['From: x', '[Open in Gmail](https://evil.example/phish)', REAL]),
      }),
      inboxCard({
        id: 'e2',
        description: description(['From: x', '[Open in Gmail](javascript:alert(1))', REAL]),
      }),
    ])
    const items = (await readEmail(CTX))!.items
    expect(items.map((i) => i.url)).toEqual([null, null])
    expect(items.map((i) => i.payload.permalink)).toEqual([null, null])
  })

  it('strips the 🔴 urgent marker and flags the Urgent column as urgent', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      inboxCard({
        id: 'u1',
        title: '🔴 Contract expires tonight',
        column: { id: 'col-urgent', name: 'Urgent' },
        priority: 'critical',
      }),
    ])
    const [item] = (await readEmail(CTX))!.items
    expect(item.title).toBe('Contract expires tonight')
    expect(item.priority).toBe('critical')
    expect(item.payload.urgent).toBe(true)
    expect(item.payload.columnName).toBe('Urgent')
  })

  it('links a pending nudge by cardId (or thread id) and marks the item urgent', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      inboxCard({ id: 'e1' }),
      inboxCard({ id: 'e2', description: description(['From: y', '`gmail:thread2`']) }),
    ])
    mockPrisma.nudge.findMany.mockResolvedValue([
      { id: 'n1', cardId: 'e1', gmailThreadId: 'realthread123', status: 'pending' },
      { id: 'n2', cardId: null, gmailThreadId: 'thread2', status: 'pending' },
    ])
    const items = (await readEmail(CTX))!.items
    expect(items.find((i) => i.sourceKey === 'email:e1')!.payload).toMatchObject({
      nudgeId: 'n1',
      urgent: true,
    })
    expect(items.find((i) => i.sourceKey === 'email:e2')!.payload).toMatchObject({
      nudgeId: 'n2',
      urgent: true,
    })
  })

  it('skips Digest / Done / closed / archived columns', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      inboxCard({ id: 'd1', column: { id: 'x', name: 'Digest' } }),
      inboxCard({ id: 'd2', column: { id: 'x', name: 'Done' } }),
      inboxCard({ id: 'd3', column: { id: 'x', name: 'closed' } }),
      inboxCard({ id: 'd4', column: { id: 'x', name: 'ARCHIVED' } }),
      inboxCard({ id: 'k1', column: { id: 'x', name: 'Triage' } }),
      inboxCard({ id: 'k2', column: { id: 'x', name: 'Urgent' } }),
    ])
    const items = (await readEmail(CTX))!.items
    expect(items.map((i) => i.sourceKey).sort()).toEqual(['email:k1', 'email:k2'])
  })

  it('falls back to the first description line as the summary when there is no From line', async () => {
    mockPrisma.card.findMany.mockResolvedValue([
      inboxCard({ description: description(['**Some subject**', REAL]) }),
    ])
    const [item] = (await readEmail(CTX))!.items
    expect(item.summary).toBe('**Some subject**')
    expect(item.payload.from).toBeNull()
  })
})
