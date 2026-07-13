// Deployment-tuning knobs for the Host Meeting HUD dispatch path. Reads only
// `process.env` (no I/O), so every helper is trivially unit-testable. Centralized
// here so the dispatch route (server enforcement) and the config API (client
// gating) share one source of truth.

import { DISPATCH_TARGETS, isDispatchTarget } from './dispatch'
import type { DispatchTarget } from './dispatch'

/** Max length of a chair's question, in characters. Bounds prompt size / abuse. */
export const MAX_QUESTION_LENGTH = 2000

/**
 * Dispatch statuses that count as in flight (occupying a ClaudeMCP job slot).
 * Shared by the dispatch route (concurrency caps), the end route (cancel on
 * session end), and the worker (bootstrap re-enqueue, run claim).
 */
export const IN_FLIGHT_DISPATCH_STATUSES: string[] = ['queued', 'running']

/** Max cards serialized per column in the board-context snapshot. */
export const MAX_CARDS_PER_COLUMN = 40

/** Hard cap on the assembled board-context string. Env: HUD_BOARD_CONTEXT_MAX_CHARS. */
export function maxBoardContextChars(): number {
  return envInt('HUD_BOARD_CONTEXT_MAX_CHARS', 16000, 500)
}

/** Max in-flight (queued|running) dispatches per HUD session. Env: HUD_MAX_INFLIGHT_PER_SESSION. */
export function maxInflightPerSession(): number {
  return envInt('HUD_MAX_INFLIGHT_PER_SESSION', 3, 1)
}

/** Max in-flight (queued|running) dispatches per org. Env: HUD_MAX_INFLIGHT_PER_ORG. */
export function maxInflightPerOrg(): number {
  return envInt('HUD_MAX_INFLIGHT_PER_ORG', 8, 1)
}

/**
 * Dispatch targets enabled for this deployment. Env: HUD_ENABLED_TARGETS (csv,
 * e.g. "board,drive"). Unset — or a value with no recognizable target — yields
 * all four (fail-open), so a typo never bricks dispatch. Trimmed, lowercased,
 * and deduped in declaration order.
 */
export function hudEnabledTargets(): DispatchTarget[] {
  const raw = process.env.HUD_ENABLED_TARGETS?.trim()
  if (!raw) return [...DISPATCH_TARGETS]
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .filter(isDispatchTarget)
  const unique = [...new Set(parsed)]
  return unique.length > 0 ? unique : [...DISPATCH_TARGETS]
}

/** Whether a given target is enabled for this deployment. */
export function isTargetEnabled(target: DispatchTarget): boolean {
  return hudEnabledTargets().includes(target)
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name]
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback
}
