// The email handoff (spec §4.11) — the planner's only path into the mailbox.
//
// Both entry points call `assertInboxOwner` BEFORE any network call: the Apps
// Script deployment addresses one person's Gmail, so org membership is not a
// control for it. They perform no other authorization and must only be called
// from a branch that has already passed the §5 route preamble.
//
// The send is deliberately two-step: `composeEmailDraft` returns the recipients
// Gmail itself computed plus a hash of the composed body, which the route
// persists; `sendEmailDraft` is then handed the *stored* Gmail draft id. A
// client-supplied draft id never reaches this module.

import { createHash } from 'crypto'
import { assertInboxOwner, inboxAgentConfig, isValidGmailId } from '@/lib/inbox-agent'
import type { SessionData } from '@/lib/session'

export class InboxAgentUnconfiguredError extends Error {
  readonly code = 'INBOX_AGENT_UNCONFIGURED' as const
  constructor(message = 'Inbox agent is not configured') {
    super(message)
    this.name = 'InboxAgentUnconfiguredError'
  }
}

export class InboxAgentUpstreamError extends Error {
  readonly code = 'INBOX_AGENT_UPSTREAM' as const
  constructor(public readonly detail: string) {
    super(detail)
    this.name = 'InboxAgentUpstreamError'
  }
}

export type ComposeArgs = { body: string; replyAll?: boolean } & (
  | { threadId: string; to?: never; subject?: never }
  | { to: string; subject: string; threadId?: never }
)

export interface ComposeResult {
  gmailDraftId: string
  preview: string
  to: string
  cc: string
  bodyHash: string
}

const MAX_BODY_CHARS = 20_000
const UPSTREAM_TIMEOUT_MS = 15_000
/** A comma-separated list of plain addresses — no display names, no folding. */
const ADDRESS_LIST_RE = /^[^,\s]+@[^,\s]+(,\s*[^,\s]+@[^,\s]+)*$/

export function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function callInboxAgent(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = inboxAgentConfig()
  if (!config) throw new InboxAgentUnconfiguredError()

  let parsed: unknown
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: config.token, ...payload }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!res.ok) throw new InboxAgentUpstreamError(`HTTP ${res.status}`)
    parsed = await res.json()
  } catch (err) {
    if (err instanceof InboxAgentUpstreamError) throw err
    throw new InboxAgentUpstreamError(err instanceof Error ? err.message : String(err))
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InboxAgentUpstreamError('malformed upstream response')
  }
  const body = parsed as Record<string, unknown>
  if (typeof body.error === 'string' && body.error) throw new InboxAgentUpstreamError(body.error)
  return body
}

/** Composes a Gmail draft with this exact body. Never calls a model upstream. */
export async function composeEmailDraft(
  session: SessionData,
  args: ComposeArgs
): Promise<ComposeResult> {
  await assertInboxOwner(session)

  if (args.body.length > MAX_BODY_CHARS) throw new Error('body too long')

  const payload: Record<string, unknown> = { action: 'compose', body: args.body }
  if (args.threadId !== undefined) {
    if (!isValidGmailId(args.threadId)) throw new Error('invalid threadId')
    payload.threadId = args.threadId
    if (args.replyAll) payload.replyAll = true
  } else {
    if (!ADDRESS_LIST_RE.test(args.to)) throw new Error('invalid recipient')
    payload.to = args.to
    payload.subject = args.subject
  }

  const body = await callInboxAgent(payload)
  const gmailDraftId = str(body.draftId)
  if (!gmailDraftId) throw new InboxAgentUpstreamError('upstream returned no draft id')

  return {
    gmailDraftId,
    preview: str(body.preview) || args.body,
    to: str(body.to),
    cc: str(body.cc),
    bodyHash: hashBody(args.body),
  }
}

/** Sends a Gmail draft the server itself composed. */
export async function sendEmailDraft(
  session: SessionData,
  gmailDraftId: string
): Promise<{ sent: true; messageId: string }> {
  await assertInboxOwner(session)

  if (!isValidGmailId(gmailDraftId)) throw new Error('invalid gmailDraftId')

  const body = await callInboxAgent({ action: 'send', draftId: gmailDraftId })
  const messageId = str(body.messageId)
  if (!messageId) throw new InboxAgentUpstreamError('upstream returned no message id')
  return { sent: true, messageId }
}
