// Google scope helpers for the Today planner (spec §4.6).
// Kept free of `./oauth` imports so a route may read scope state without
// pulling the token machinery in.

import { prisma } from '../db'
import { GoogleAuthExpiredError, InsufficientScopesError } from './errors'

export const CALENDAR_EVENTS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.events.readonly'
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** The scopes the planner adds on top of REQUIRED_SCOPES (oauth.ts). */
export const PLANNER_SCOPES = [CALENDAR_EVENTS_READONLY_SCOPE, DRIVE_FILE_SCOPE] as const

/** Returns the subset of `needed` absent from the space-separated `granted` string. */
export function missingScopes(granted: string, needed: readonly string[]): string[] {
  const held = new Set((granted ?? '').split(/\s+/).filter(Boolean))
  return needed.filter((scope) => !held.has(scope))
}

/**
 * Reads the user's credential and throws when a needed scope is absent, so a
 * caller never spends a Google call it is not authorised to make.
 */
export async function assertScopes(userId: string, needed: readonly string[]): Promise<void> {
  const cred = await prisma.googleCredential.findUnique({ where: { userId } })
  if (!cred) throw new GoogleAuthExpiredError()

  const missing = missingScopes(cred.scopes, needed)
  if (missing.length > 0) throw new InsufficientScopesError(missing)
}
