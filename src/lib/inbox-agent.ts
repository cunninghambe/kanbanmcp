import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { SessionData } from '@/lib/session'

/**
 * Authorization for the Gmail inbox agent.
 *
 * The inbox agent is NOT an org-scoped feature: `INBOX_AGENT_URL` /
 * `INBOX_AGENT_TOKEN` point at ONE Apps Script deployment holding ONE person's
 * Gmail. Anything that reaches it can read any thread in that mailbox and send
 * mail as its owner. Org membership is therefore the wrong control — any
 * registered user is a MEMBER of their own org, so `requireOrgRole(session,
 * session.orgId, 'MEMBER')` is a tautology that authorizes everyone on the
 * instance, including users from unrelated orgs.
 *
 * The correct control is an explicit owner allowlist. This module is the single
 * place that decides who may touch the mailbox, and it FAILS CLOSED: with
 * `INBOX_AGENT_OWNER` unset, nobody is authorized (503), rather than everybody.
 */

/** Lowercased owner emails from INBOX_AGENT_OWNER (comma-separated). */
export function inboxOwnerEmails(): string[] {
  return (process.env.INBOX_AGENT_OWNER ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

/** Apps Script endpoint config, or null when the feature is unconfigured. */
export function inboxAgentConfig(): { url: string; token: string } | null {
  const url = process.env.INBOX_AGENT_URL
  const token = process.env.INBOX_AGENT_TOKEN
  if (!url || !token) return null
  return { url, token }
}

/**
 * True when the session belongs to a mailbox owner. API-key sessions are never
 * owners (they carry no user identity and must not reach a mailbox).
 */
export async function isInboxOwner(session: SessionData): Promise<boolean> {
  if (session.isApiKeyAuth || !session.userId) return false
  const owners = inboxOwnerEmails()
  if (owners.length === 0) return false // fail closed

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true },
  })
  if (!user?.email) return false
  return owners.includes(user.email.toLowerCase())
}

/**
 * Throws a NextResponse unless the session may act on the mailbox.
 *   503 — feature unconfigured (no owner allowlist, or no endpoint)
 *   403 — authenticated, but not a mailbox owner
 * Callers that must not leak existence to non-owners should use isInboxOwner()
 * and degrade quietly instead.
 */
export async function assertInboxOwner(session: SessionData): Promise<void> {
  if (inboxOwnerEmails().length === 0) {
    throw NextResponse.json(
      { error: 'Inbox agent is not configured (INBOX_AGENT_OWNER unset)' },
      { status: 503 }
    )
  }
  if (!(await isInboxOwner(session))) {
    throw NextResponse.json(
      { error: 'Forbidden: this mailbox belongs to another user' },
      { status: 403 }
    )
  }
}

/**
 * Gmail thread/draft ids are opaque URL-safe tokens. Constrain them so nothing
 * shaped like a URL, a JSON fragment, or a giant blob is relayed upstream.
 */
export const GMAIL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function isValidGmailId(value: string): boolean {
  return GMAIL_ID_PATTERN.test(value)
}

/**
 * Pulls the Gmail thread id out of a card description written by the inbox
 * agent, which emits it as the LAST line, alone, in backticks: `` `gmail:<id>` ``.
 *
 * Anchoring matters. Everything above that line is untrusted — the email
 * subject, and LLM-derived summary/deadline/action text — so a loose,
 * first-match `/gmail:([\w-]+)/` would let a sender put
 * "Invoice question gmail:<theirThreadId>" in a subject line and silently
 * re-point the reply panel at a thread of their choosing. The user would then
 * approve a reply that goes to the attacker instead of the real correspondent.
 * Match only the exact marker line, and take the last one.
 */
export function extractGmailThreadId(description: string | null | undefined): string | null {
  if (!description) return null
  const matches = [...description.matchAll(/^`gmail:([A-Za-z0-9_-]+)`$/gm)]
  return matches.at(-1)?.[1] ?? null
}
