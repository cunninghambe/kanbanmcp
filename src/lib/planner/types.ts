// Shared constants and DTOs for the Today planner.
// Spec: docs/specs/mhud-today-planner.md §4.1. Both server code and client
// components import from here — keep it free of Node-only and Prisma runtime
// imports (types only).

import type { PlannerDraft, PlannerItem } from '@prisma/client'

export const PLANNER_SOURCES = ['card', 'email', 'calendar', 'slack', 'manual'] as const
export type PlannerSource = (typeof PLANNER_SOURCES)[number]

export const COLLECTED_SOURCES = ['card', 'email', 'calendar', 'slack'] as const
export type CollectedSource = (typeof COLLECTED_SOURCES)[number]

export const PLANNER_STATUSES = ['open', 'done', 'dismissed', 'snoozed', 'wont_do'] as const
export type PlannerStatus = (typeof PLANNER_STATUSES)[number]

export const PLANNER_ACTIONS = ['done', 'dismiss', 'wont_do', 'snooze', 'reopen'] as const
export type PlannerAction = (typeof PLANNER_ACTIONS)[number]

export const PLANNER_PRIORITIES = ['none', 'low', 'medium', 'high', 'critical'] as const
export type PlannerPriority = (typeof PLANNER_PRIORITIES)[number]

export const PLANNER_SECTIONS = [
  'now',
  'today',
  'soon',
  'later',
  'snoozed',
  'done',
  'wont_do',
  'dismissed',
] as const
export type PlannerSection = (typeof PLANNER_SECTIONS)[number]

export type SourceStatus = 'ok' | 'error' | 'skipped' | 'needs_scope'

export type ResolvedBy = 'user' | 'source' | 'elapsed'

export interface PlannerItemDTO {
  id: string
  source: PlannerSource
  sourceKey: string
  title: string
  summary: string | null
  url: string | null
  priority: PlannerPriority
  dueAt: string | null
  startsAt: string | null
  endsAt: string | null
  status: PlannerStatus
  snoozedUntil: string | null
  resolvedBy: ResolvedBy | null
  resolvedAt: string | null
  prepNotes: string | null
  payload: Record<string, unknown>
  lastSeenAt: string
  createdAt: string
  updatedAt: string
}

export interface RankedItemDTO extends PlannerItemDTO {
  score: number
  reasons: string[]
  section: PlannerSection
}

export interface DayWindow {
  start: Date
  end: Date
}

/** What a source reader returns for one item. */
export interface SourceItem {
  sourceKey: string
  title: string
  summary?: string | null
  url?: string | null
  priority?: PlannerPriority
  dueAt?: Date | null
  startsAt?: Date | null
  endsAt?: Date | null
  payload: Record<string, unknown>
}

export interface SourceRead {
  items: SourceItem[]
  /**
   * Which of this source's previously-collected items are auto-resolved when
   * absent from `items`:
   *   'all'     — open AND snoozed rows (absence is a fact: the card left the board) — cards, email
   *   'open'    — open rows only (absence just means "older than the lookback") — slack
   *   'none'    — nothing (the read was partial/truncated)
   *   DayWindow — open AND snoozed rows whose startsAt lies inside the fully-read window — calendar
   */
  resolveMissing: 'all' | 'open' | 'none' | DayWindow
}

export interface SourceContext {
  userId: string
  orgId: string
  /** IANA zone of the request; needed to map all-day events to local days. */
  tz: string
  now: Date
  window: DayWindow
}

/** Returns null when the source is not configured/connected for this user (→ 'skipped'). */
export type SourceReader = (ctx: SourceContext) => Promise<SourceRead | null>

export interface CollectResult {
  upserted: number
  resolved: number
  status: Record<CollectedSource, SourceStatus>
  errors: Partial<Record<CollectedSource, string>>
}

export interface TodayCounts {
  now: number
  open: number
  overdue: number
  /** calendar items overlapping the window, excluding all-day */
  meetingsToday: number
  inbox: number
  slack: number
  doneToday: number
  dismissed: number
}

export interface TodayResponse {
  date: string
  tz: string
  window: { start: string; end: string }
  collectedAt: string | null
  sources: Record<CollectedSource, SourceStatus>
  sourceErrors: Partial<Record<CollectedSource, string>>
  brief: { text: string; model: string | null; at: string } | null
  items: RankedItemDTO[]
  /** true when either item query hit its cap (spec §4.12) — the UI shows a notice */
  truncated: boolean
  counts: TodayCounts
}

export interface PlannerHandoffRecord {
  kind: string
  ref: string
  url?: string
  at: string
}

/** Persisted by email_compose, consumed by email_send (spec §5.6). */
export interface PendingEmail {
  gmailDraftId: string
  to: string
  cc: string
  threadId: string | null
  /** sha256 hex of the composed body — the send is refused when the body changed */
  bodyHash: string
  at: string
}

export interface PlannerDraftDTO {
  id: string
  itemId: string | null
  title: string
  body: string
  status: 'draft' | 'handed_off'
  handoff: PlannerHandoffRecord | null
  pendingEmail: PendingEmail | null
  createdAt: string
  updatedAt: string
}

// ─── cross-WI types (no runtime imports, client-safe) ────────────────────────

export type WriteThroughKind = 'none' | 'card_moved' | 'nudge_acked'

export type WriteThroughResult =
  | { kind: 'none'; ok: true; reason?: 'not_applicable' | 'no_done_column' | 'card_missing' }
  | { kind: 'card_moved'; ok: true; cardId: string; toColumnId: string; toColumnName: string }
  | { kind: 'nudge_acked'; ok: true; nudgeId: string }
  | { kind: 'card_moved' | 'nudge_acked'; ok: false; error: string }

export type DraftMode = 'reply_email' | 'document' | 'slack_message' | 'freeform'
export const DRAFT_MODES = ['reply_email', 'document', 'slack_message', 'freeform'] as const

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parses a JSON column tolerantly: anything that is not a JSON object becomes `{}`. */
export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

function asSource(v: string): PlannerSource {
  return (PLANNER_SOURCES as readonly string[]).includes(v) ? (v as PlannerSource) : 'manual'
}

function asStatus(v: string): PlannerStatus {
  return (PLANNER_STATUSES as readonly string[]).includes(v) ? (v as PlannerStatus) : 'open'
}

function asPriority(v: string | null | undefined): PlannerPriority {
  return v && (PLANNER_PRIORITIES as readonly string[]).includes(v)
    ? (v as PlannerPriority)
    : 'none'
}

function asResolvedBy(v: string | null): ResolvedBy | null {
  return v === 'user' || v === 'source' || v === 'elapsed' ? v : null
}

/** Row → DTO. `payload` JSON that fails to parse becomes `{}` (never throws). */
export function toPlannerItemDTO(row: PlannerItem): PlannerItemDTO {
  return {
    id: row.id,
    source: asSource(row.source),
    sourceKey: row.sourceKey,
    title: row.title,
    summary: row.summary ?? null,
    url: row.url ?? null,
    priority: asPriority(row.priority),
    dueAt: iso(row.dueAt),
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    status: asStatus(row.status),
    snoozedUntil: iso(row.snoozedUntil),
    resolvedBy: asResolvedBy(row.resolvedBy),
    resolvedAt: iso(row.resolvedAt),
    prepNotes: row.prepNotes ?? null,
    payload: parseJsonObject(row.payload),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Row → DTO. A malformed `handoff` JSON becomes `null`. */
export function toPlannerDraftDTO(row: PlannerDraft): PlannerDraftDTO {
  const raw = parseJsonObject(row.handoff)
  const handoff: PlannerHandoffRecord | null =
    typeof raw.kind === 'string' && typeof raw.ref === 'string' && typeof raw.at === 'string'
      ? {
          kind: raw.kind,
          ref: raw.ref,
          at: raw.at,
          ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
        }
      : null
  const pe = parseJsonObject(row.pendingEmail)
  const pendingEmail: PendingEmail | null =
    typeof pe.gmailDraftId === 'string' &&
    typeof pe.bodyHash === 'string' &&
    typeof pe.at === 'string'
      ? {
          gmailDraftId: pe.gmailDraftId,
          to: typeof pe.to === 'string' ? pe.to : '',
          cc: typeof pe.cc === 'string' ? pe.cc : '',
          threadId: typeof pe.threadId === 'string' ? pe.threadId : null,
          bodyHash: pe.bodyHash,
          at: pe.at,
        }
      : null
  return {
    id: row.id,
    itemId: row.itemId ?? null,
    title: row.title,
    body: row.body,
    status: row.status === 'handed_off' ? 'handed_off' : 'draft',
    handoff,
    pendingEmail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Scheme allowlist for anything that becomes an href: absolute http(s) URLs
 * only (normalized). No mailto, no javascript, no data, no relative paths.
 */
export function safeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
}

/**
 * URL allowed on a planner item: an absolute http(s) URL, or an app-relative
 * path (single leading slash, no scheme, no protocol-relative `//`).
 */
export function safeItemUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !/[\s\\]/.test(trimmed)) {
    return trimmed
  }
  return safeHttpUrl(trimmed)
}
