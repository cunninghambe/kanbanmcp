// Pure end-of-meeting digest builder: computes stats and renders markdown for
// the HUD wrap-up view from pre-fetched rows. No I/O, no Date.now() — every
// value is derived from the input. See
// docs/specs/2026-07-13-hud-meeting-manager.md §3.5.
import type { AgentDispatch, HudEntry } from '@prisma/client'

const ANSWER_EXCERPT_LIMIT = 200

export interface DigestInput {
  session: { id: string; title: string; startedAt: Date; endedAt: Date | null }
  boardName: string | null
  entries: HudEntry[]
  dispatches: Array<Pick<AgentDispatch, 'target' | 'question' | 'status' | 'answer'>>
  changeSets: Array<{ id: string; status: string; summary: string | null; itemCount: number }>
  memberNames: Map<string, string>
}

export interface DigestStats {
  durationMs: number | null
  dispatches: number
  answered: number
  failed: number
  proposals: number
  proposalsPending: number
  actions: number
  actionsWithCards: number
  decisions: number
  notes: number
  agendaDone: number
  agendaTotal: number
}

export interface DigestAgendaItem {
  text: string
  checked: boolean
}

export interface DigestLogItem {
  text: string
  at: string
}

export interface DigestAction {
  text: string
  assigneeName: string | null
  dueDate: string | null
  cardId: string | null
}

export interface DigestDispatch {
  target: string
  question: string
  status: string
  answerExcerpt: string | null
}

export interface DigestChangeSet {
  id: string
  status: string
  summary: string | null
  itemCount: number
}

export interface Digest {
  stats: DigestStats
  agenda: DigestAgendaItem[]
  decisions: DigestLogItem[]
  notes: DigestLogItem[]
  actions: DigestAction[]
  dispatches: DigestDispatch[]
  changeSets: DigestChangeSet[]
  markdown: string
}

export function buildDigest(input: DigestInput): Digest {
  const agenda = input.entries
    .filter((e) => e.kind === 'agenda')
    .map((e) => ({ text: e.text, checked: e.checkedAt !== null }))
  const decisions = input.entries
    .filter((e) => e.kind === 'decision')
    .map((e) => ({ text: e.text, at: e.createdAt.toISOString() }))
  const notes = input.entries
    .filter((e) => e.kind === 'note')
    .map((e) => ({ text: e.text, at: e.createdAt.toISOString() }))
  const actions = input.entries
    .filter((e) => e.kind === 'action')
    .map((e) => ({
      text: e.text,
      assigneeName: e.assigneeId ? (input.memberNames.get(e.assigneeId) ?? null) : null,
      dueDate: e.dueDate ? formatDateYMD(e.dueDate) : null,
      cardId: e.cardId,
    }))
  const dispatches = input.dispatches.map((d) => ({
    target: d.target,
    question: d.question,
    status: d.status,
    answerExcerpt: excerptAnswer(d.answer),
  }))
  const changeSets = input.changeSets.map((c) => ({ ...c }))

  const durationMs = input.session.endedAt
    ? input.session.endedAt.getTime() - input.session.startedAt.getTime()
    : null

  const stats: DigestStats = {
    durationMs,
    dispatches: dispatches.length,
    answered: dispatches.filter((d) => d.status === 'done').length,
    failed: dispatches.filter((d) => d.status === 'failed').length,
    proposals: changeSets.length,
    proposalsPending: changeSets.filter((c) => c.status === 'pending').length,
    actions: actions.length,
    actionsWithCards: actions.filter((a) => a.cardId !== null).length,
    decisions: decisions.length,
    notes: notes.length,
    agendaDone: agenda.filter((a) => a.checked).length,
    agendaTotal: agenda.length,
  }

  const markdown = renderMarkdown(input, stats, { agenda, decisions, notes, actions, dispatches, changeSets })

  return { stats, agenda, decisions, notes, actions, dispatches, changeSets, markdown }
}

interface DigestSections {
  agenda: DigestAgendaItem[]
  decisions: DigestLogItem[]
  notes: DigestLogItem[]
  actions: DigestAction[]
  dispatches: DigestDispatch[]
  changeSets: DigestChangeSet[]
}

interface MarkdownBlock {
  header: string
  rows: string[]
}

function renderMarkdown(input: DigestInput, stats: DigestStats, sections: DigestSections): string {
  const lines: string[] = [
    `# ${input.session.title} — meeting digest`,
    formatWhenLine(input.session.startedAt, input.session.endedAt, stats.durationMs),
  ]
  if (input.boardName !== null) lines.push(`**Board:** ${input.boardName}`)

  const blocks = [
    section(sections.decisions.length > 0, '## Decisions', sections.decisions.map((d) => `- ${d.text}`)),
    section(sections.actions.length > 0, '## Action items', sections.actions.map(formatActionLine)),
    section(
      stats.agendaTotal > 0,
      `## Agenda (${stats.agendaDone}/${stats.agendaTotal})`,
      sections.agenda.map((a) => `- [${a.checked ? 'x' : ' '}] ${a.text}`)
    ),
    section(sections.notes.length > 0, '## Notes', sections.notes.map((n) => `- ${n.text}`)),
    section(
      sections.dispatches.length > 0,
      `## Agent dispatches (${sections.dispatches.length})`,
      sections.dispatches.map((d) => `- **${d.target}** ${d.question} — ${d.status}`)
    ),
    section(
      sections.changeSets.length > 0,
      '## Proposed changes',
      sections.changeSets.map((c) => `- ${c.summary ?? '(no summary)'} — ${c.status}, ${c.itemCount} items`)
    ),
  ].filter((b): b is MarkdownBlock => b !== null)

  for (const block of blocks) lines.push('', block.header, ...block.rows)

  return lines.join('\n')
}

function section(active: boolean, header: string, rows: string[]): MarkdownBlock | null {
  return active ? { header, rows } : null
}

/** `- [ ] text — @assignee, due YYYY-MM-DD (card: id)`, each fragment omitted when null. */
function formatActionLine(action: DigestAction): string {
  const middle = [
    action.assigneeName ? `@${action.assigneeName}` : null,
    action.dueDate ? `due ${action.dueDate}` : null,
  ]
    .filter((f): f is string => f !== null)
    .join(', ')
  const cardFragment = action.cardId ? `(card: ${action.cardId})` : null
  const suffixParts = [middle || null, cardFragment].filter((f): f is string => f !== null)
  const suffix = suffixParts.length > 0 ? ` — ${suffixParts.join(' ')}` : ''
  return `- [${action.cardId ? 'x' : ' '}] ${action.text}${suffix}`
}

function formatWhenLine(startedAt: Date, endedAt: Date | null, durationMs: number | null): string {
  const started = formatLocal(startedAt)
  if (endedAt === null || durationMs === null) return `**When:** ${started} → (live)`
  return `**When:** ${started} → ${formatLocal(endedAt)} (${formatDuration(durationMs)})`
}

function formatLocal(date: Date): string {
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

/** `h:mm`, rounded to the nearest minute. */
function formatDuration(durationMs: number): string {
  const totalMinutes = Math.round(durationMs / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}:${String(minutes).padStart(2, '0')}`
}

/** Local calendar date — matches the local-midnight dates the capture parser produces. */
function formatDateYMD(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** First 200 chars of the answer; `…` appended only when truncated. */
function excerptAnswer(answer: string | null): string | null {
  if (answer === null) return null
  if (answer.length <= ANSWER_EXCERPT_LIMIT) return answer
  return `${answer.slice(0, ANSWER_EXCERPT_LIMIT)}…`
}
