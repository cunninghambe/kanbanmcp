import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  MAX_QUESTION_LENGTH,
  MAX_CARDS_PER_COLUMN,
  maxBoardContextChars,
  maxInflightPerSession,
  maxInflightPerOrg,
  hudEnabledTargets,
  isTargetEnabled,
} from '../../src/lib/host-hud/config'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('host-hud config constants', () => {
  it('exposes stable bound constants', () => {
    expect(MAX_QUESTION_LENGTH).toBe(2000)
    expect(MAX_CARDS_PER_COLUMN).toBe(40)
  })
})

describe('maxBoardContextChars', () => {
  it('defaults when unset', () => {
    expect(maxBoardContextChars()).toBe(16000)
  })
  it('honors a valid override', () => {
    vi.stubEnv('HUD_BOARD_CONTEXT_MAX_CHARS', '8000')
    expect(maxBoardContextChars()).toBe(8000)
  })
  it('falls back on garbage or below-minimum values', () => {
    vi.stubEnv('HUD_BOARD_CONTEXT_MAX_CHARS', 'abc')
    expect(maxBoardContextChars()).toBe(16000)
    vi.stubEnv('HUD_BOARD_CONTEXT_MAX_CHARS', '100')
    expect(maxBoardContextChars()).toBe(16000)
  })
})

describe('concurrency caps', () => {
  it('default per-session is 3, per-org is 8', () => {
    expect(maxInflightPerSession()).toBe(3)
    expect(maxInflightPerOrg()).toBe(8)
  })
  it('honor valid overrides and reject invalid ones', () => {
    vi.stubEnv('HUD_MAX_INFLIGHT_PER_SESSION', '5')
    expect(maxInflightPerSession()).toBe(5)
    vi.stubEnv('HUD_MAX_INFLIGHT_PER_SESSION', '0')
    expect(maxInflightPerSession()).toBe(3)
    vi.stubEnv('HUD_MAX_INFLIGHT_PER_ORG', 'nope')
    expect(maxInflightPerOrg()).toBe(8)
  })
})

describe('hudEnabledTargets', () => {
  it('returns all four targets when unset', () => {
    expect(hudEnabledTargets().sort()).toEqual(['board', 'drive', 'email', 'slack'])
  })
  it('parses a csv subset, trimming and lowercasing', () => {
    vi.stubEnv('HUD_ENABLED_TARGETS', ' board, Drive ')
    expect(hudEnabledTargets()).toEqual(['board', 'drive'])
  })
  it('drops invalid entries and dedupes', () => {
    vi.stubEnv('HUD_ENABLED_TARGETS', 'board,board,bogus,drive')
    expect(hudEnabledTargets()).toEqual(['board', 'drive'])
  })
  it('fails open to all four when every entry is invalid', () => {
    vi.stubEnv('HUD_ENABLED_TARGETS', 'bogus,nonsense')
    expect(hudEnabledTargets().sort()).toEqual(['board', 'drive', 'email', 'slack'])
  })
})

describe('isTargetEnabled', () => {
  it('reflects the configured set', () => {
    vi.stubEnv('HUD_ENABLED_TARGETS', 'board,drive')
    expect(isTargetEnabled('board')).toBe(true)
    expect(isTargetEnabled('slack')).toBe(false)
  })
})
