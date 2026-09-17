// Email source for the Today planner.
// Spec: docs/specs/mhud-today-planner.md §4.5 (email.ts).
//
// The substrate is the Gmail inbox agent's own board cards plus its pending
// nudges — no new Gmail read code. INBOX_AGENT_URL/TOKEN address ONE person's
// mailbox, so this reader is gated by the owner allowlist and FAILS CLOSED:
// with INBOX_AGENT_OWNER unset nobody is an owner and the source is skipped for
// everyone. The queries below are org-wide (the inbox board is org-scoped and
// Nudge has no per-user column), so a fail-open gate would put one mailbox's
// subjects, senders and Gmail permalinks on every org member's page.

import { prisma } from '@/lib/db'
import { extractGmailThreadId, isInboxOwner } from '@/lib/inbox-agent'
import { PLANNER_PRIORITIES, safeHttpUrl } from '../types'
import type { PlannerPriority, SourceContext, SourceItem, SourceRead } from '../types'

/** Inbox-board columns that are not actionable email. */
const SKIP_COLUMNS = new Set(['done', 'digest', 'closed', 'archived'])
const URGENT_COLUMN = 'urgent'

/** Leading inbox-agent markers on a card title: 🔴 (urgent) and ✉️ (mail). */
const TITLE_MARKER_RE = /^(?:\u{1F534}|\u{2709})\u{FE0F}?\s*/u
const GMAIL_LINK_RE = /\[Open in Gmail\]\(([^)\s]*)\)/g
const GMAIL_PERMALINK_HOST = 'mail.google.com'
const FROM_LINE_RE = /^From:\s*(.+)$/

interface InboxCardRow {
  id: string
  title: string
  description: string | null
  boardId: string
  priority: string
  dueDate: Date | null
  column: { id: string; name: string }
}

interface NudgeRow {
  id: string
  cardId: string | null
  gmailThreadId: string | null
}

function asPriority(value: string | null | undefined): PlannerPriority {
  return value && (PLANNER_PRIORITIES as readonly string[]).includes(value)
    ? (value as PlannerPriority)
    : 'none'
}

/** The inbox agent's own Gmail deep link, accepted only on mail.google.com. */
function gmailPermalink(description: string | null): string | null {
  if (!description) return null
  for (const match of description.matchAll(GMAIL_LINK_RE)) {
    const href = safeHttpUrl(match[1])
    if (href && new URL(href).host === GMAIL_PERMALINK_HOST) return href
  }
  return null
}

/** The display sender from the agent's `From: ` line. */
function senderLine(description: string | null): string | null {
  if (!description) return null
  for (const line of description.split('\n')) {
    const match = FROM_LINE_RE.exec(line.trim())
    if (match) return match[1].trim()
  }
  return null
}

function firstLine(description: string | null): string | null {
  if (!description) return null
  for (const line of description.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return null
}

export async function readEmail(ctx: SourceContext): Promise<SourceRead | null> {
  const boardId = process.env.INBOX_BOARD_ID
  if (!boardId) return null
  if (!(await isInboxOwner({ userId: ctx.userId, orgId: ctx.orgId }))) return null

  const cards: InboxCardRow[] = await prisma.card.findMany({
    where: { boardId, board: { orgId: ctx.orgId } },
    include: { column: { select: { id: true, name: true } } },
  })
  const nudges: NudgeRow[] = await prisma.nudge.findMany({
    where: { orgId: ctx.orgId, status: 'pending' },
  })

  const items: SourceItem[] = []
  for (const card of cards) {
    const columnName = card.column?.name ?? ''
    const columnKey = columnName.toLowerCase()
    if (SKIP_COLUMNS.has(columnKey)) continue

    // Anchored marker only — a `gmail:<id>` string smuggled into the subject or
    // the agent's summary must never re-point the reply panel (PR #38).
    const gmailThreadId = extractGmailThreadId(card.description)
    const permalink = gmailPermalink(card.description)
    const from = senderLine(card.description)
    const nudge =
      nudges.find(
        (n) =>
          (n.cardId !== null && n.cardId === card.id) ||
          (gmailThreadId !== null && n.gmailThreadId === gmailThreadId)
      ) ?? null

    items.push({
      sourceKey: `email:${card.id}`,
      title: card.title.replace(TITLE_MARKER_RE, '').trim(),
      summary: from ?? firstLine(card.description),
      url: permalink,
      priority: asPriority(card.priority),
      dueAt: card.dueDate ?? null,
      payload: {
        cardId: card.id,
        boardId: card.boardId,
        columnName,
        gmailThreadId,
        from,
        permalink,
        nudgeId: nudge?.id ?? null,
        urgent: columnKey === URGENT_COLUMN || nudge !== null,
      },
    })
  }

  // The inbox board is read in full, so a card that is gone (archived, moved to
  // Done, deleted) is a fact: it resolves open and snoozed rows alike.
  return { items, resolveMissing: 'all' }
}
