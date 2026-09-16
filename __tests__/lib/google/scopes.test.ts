/**
 * Google scope helpers (spec §4.6 scopes.ts). (WI-2)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  googleCredential: { findUnique: vi.fn() },
}))
vi.mock('../../../src/lib/db', () => ({ prisma: mockPrisma, default: mockPrisma }))

import {
  CALENDAR_EVENTS_READONLY_SCOPE,
  DRIVE_FILE_SCOPE,
  PLANNER_SCOPES,
  assertScopes,
  missingScopes,
} from '../../../src/lib/google/scopes'
import { GoogleAuthExpiredError, InsufficientScopesError } from '../../../src/lib/google/errors'

describe('google/scopes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('names the two planner scopes', () => {
    expect(CALENDAR_EVENTS_READONLY_SCOPE).toBe(
      'https://www.googleapis.com/auth/calendar.events.readonly'
    )
    expect(DRIVE_FILE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file')
    expect([...PLANNER_SCOPES]).toEqual([CALENDAR_EVENTS_READONLY_SCOPE, DRIVE_FILE_SCOPE])
  })

  it('missingScopes returns the subset absent from a space-separated grant', () => {
    expect(missingScopes('a b c', ['a', 'c'])).toEqual([])
    expect(missingScopes('a b', ['a', 'c', 'd'])).toEqual(['c', 'd'])
    expect(missingScopes('', ['a'])).toEqual(['a'])
    expect(missingScopes('  a   b ', ['b'])).toEqual([])
  })

  it('assertScopes resolves when the credential holds every needed scope', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      scopes: `https://www.googleapis.com/auth/drive.readonly ${CALENDAR_EVENTS_READONLY_SCOPE}`,
    })
    await expect(assertScopes('user-1', [CALENDAR_EVENTS_READONLY_SCOPE])).resolves.toBeUndefined()
    expect(mockPrisma.googleCredential.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } })
    )
  })

  it('assertScopes throws InsufficientScopesError listing exactly the missing scopes', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue({
      scopes: 'https://www.googleapis.com/auth/drive.readonly',
    })
    const err = await assertScopes('user-1', PLANNER_SCOPES).catch((e) => e)
    expect(err).toBeInstanceOf(InsufficientScopesError)
    expect((err as InsufficientScopesError).missing).toEqual([
      CALENDAR_EVENTS_READONLY_SCOPE,
      DRIVE_FILE_SCOPE,
    ])
  })

  it('assertScopes throws GoogleAuthExpiredError when there is no credential', async () => {
    mockPrisma.googleCredential.findUnique.mockResolvedValue(null)
    await expect(assertScopes('user-1', [DRIVE_FILE_SCOPE])).rejects.toBeInstanceOf(
      GoogleAuthExpiredError
    )
  })
})
