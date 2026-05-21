/**
 * Unit tests for src/lib/card-execution/triggers.ts (Task 9 — not yet implemented)
 *
 * Covers: trigger truth table (spec §"Trigger logic"), AC1, AC2, AC3, AC4, AC11, AC12, E1, E2, E4
 *
 * All tests use vi.useFakeTimers() — no real waiting.
 * Tests will FAIL until Task 10 implements the module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock prisma ──────────────────────────────────────────────────────────────
vi.mock('../../src/lib/db', () => {
  const p = {
    card: { findUnique: vi.fn() },
    cardExecution: { findFirst: vi.fn() },
  }
  return { prisma: p }
})

// ─── Import after mocks ───────────────────────────────────────────────────────
import { prisma } from '../../src/lib/db'
import {
  maybeStartExecutionDebounce,
  __setFireForTests,
  resetTimersForTests,
  DEBOUNCE_MS,
} from '../../src/lib/card-execution/triggers'

// ─── Typed mock helpers ───────────────────────────────────────────────────────
type MockFn = ReturnType<typeof vi.fn>
const mockPrisma = prisma as unknown as {
  card: { findUnique: MockFn }
  cardExecution: { findFirst: MockFn }
}

// ─── Constants under test ─────────────────────────────────────────────────────
const CLAUDE_CODE_ASSIGNEE = 'agent-claude-code'
const CARD_ID = 'card-abc123'

// ─── Shared setup ─────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetTimersForTests()

  // Default: card has a non-empty description and no active execution.
  mockPrisma.card.findUnique.mockResolvedValue({
    id: CARD_ID,
    description: 'Build the feature',
  })
  mockPrisma.cardExecution.findFirst.mockResolvedValue(null)
})

afterEach(() => {
  __setFireForTests(null)
  vi.useRealTimers()
})

// ─── DEBOUNCE_MS constant ─────────────────────────────────────────────────────
describe('DEBOUNCE_MS', () => {
  it('equals 60 000', () => {
    expect(DEBOUNCE_MS).toBe(60_000)
  })
})

// ─── AC1: Happy path ──────────────────────────────────────────────────────────
describe('AC1 — happy path: fire spy called after 60s', () => {
  it('fires exactly once after 60s when card moves into "In Progress" with claude-code assignee and description', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })

    // Timer has not elapsed yet — fire not called
    expect(fire).not.toHaveBeenCalled()

    // After 60s
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(fire).toHaveBeenCalledTimes(1)
    expect(fire).toHaveBeenCalledWith(CARD_ID)
  })

  it('AC1 case-insensitive: column "in progress" (all lowercase) triggers the debounce', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'in progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(fire).toHaveBeenCalledTimes(1)
    expect(fire).toHaveBeenCalledWith(CARD_ID)
  })
})

// ─── AC2: Debounce cancelled by moving out ────────────────────────────────────
describe('AC2 — debounce cancelled when card moves out before timer fires', () => {
  it('does not fire when card moves to "Backlog" 30s after entering "In Progress"', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // Trigger to In Progress
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })

    // 30s later, move out
    await vi.advanceTimersByTimeAsync(30_000)
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'In Progress',
      newColumnName: 'Backlog',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })

    // Advance another 60s — original timer would have fired here
    await vi.advanceTimersByTimeAsync(60_000)

    // Then: fire is NEVER called
    expect(fire).not.toHaveBeenCalled()
  })
})

// ─── AC3: Debounce reset ──────────────────────────────────────────────────────
describe('AC3 — debounce resets on second In Progress trigger (E1)', () => {
  it('fires 60s after the second trigger, not 60s after the first', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // First trigger
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })

    // 30s later: second trigger (same card, same column)
    await vi.advanceTimersByTimeAsync(30_000)
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })

    // Advance to 90s total (60s after first trigger) — must NOT have fired yet
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fire).not.toHaveBeenCalled()

    // Advance the remaining 30s (60s after second trigger)
    await vi.advanceTimersByTimeAsync(30_000)

    // Then: fired exactly once, 60s after the second trigger
    expect(fire).toHaveBeenCalledTimes(1)
    expect(fire).toHaveBeenCalledWith(CARD_ID)
  })
})

// ─── AC4 / AC11: Active execution already exists ──────────────────────────────
describe('AC4 / AC11 — active CardExecution blocks timer (E4)', () => {
  it('does not start timer when an enqueued CardExecution already exists for the card', async () => {
    // Given: active execution present
    mockPrisma.cardExecution.findFirst.mockResolvedValue({
      id: 'exec-1',
      cardId: CARD_ID,
      state: 'enqueued',
    })

    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })
    await vi.advanceTimersByTimeAsync(60_000)

    // Then: no timer started, fire never called
    expect(fire).not.toHaveBeenCalled()
  })

  it('does not start timer when a running CardExecution already exists for the card', async () => {
    // Given: running execution present
    mockPrisma.cardExecution.findFirst.mockResolvedValue({
      id: 'exec-2',
      cardId: CARD_ID,
      state: 'running',
    })

    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(fire).not.toHaveBeenCalled()
  })
})

// ─── AC12: Empty description ──────────────────────────────────────────────────
describe('AC12 — empty description: no timer, no fire, no comment (E2)', () => {
  it('does not start timer when card description is empty string', async () => {
    // Given: empty description
    mockPrisma.card.findUnique.mockResolvedValue({
      id: CARD_ID,
      description: '',
    })

    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(fire).not.toHaveBeenCalled()
  })

  it('does not start timer when card description is whitespace-only', async () => {
    // Given: whitespace-only description
    mockPrisma.card.findUnique.mockResolvedValue({
      id: CARD_ID,
      description: '   \n\t  ',
    })

    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(fire).not.toHaveBeenCalled()
  })
})

// ─── Assignee not Claude Code ─────────────────────────────────────────────────
describe('trigger truth table — assignee is not agent-claude-code', () => {
  it('does not start timer when assignee is a regular user', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: 'user-human-123',
    })
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(fire).not.toHaveBeenCalled()
  })

  it('does not start timer when assigneeId is null', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: null,
    })
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(fire).not.toHaveBeenCalled()
  })
})

// ─── New column is not "In Progress" ─────────────────────────────────────────
describe('trigger truth table — new column is not "In Progress"', () => {
  it('does not start timer when card moves to "Review"', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'In Progress',
      newColumnName: 'Review',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(fire).not.toHaveBeenCalled()
  })

  it('does not start timer when newColumnName equals prevColumnName (no real move)', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // When — same column as prev (edge: identical names, neither is "In Progress")
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'Backlog',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    expect(fire).not.toHaveBeenCalled()
  })
})

// ─── Moving OUT cancels an existing pending timer ─────────────────────────────
describe('moving out of "In Progress" cancels a pending timer', () => {
  it('cancels timer when card moves to "Done" 30s after entering "In Progress"', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })

    // 30s later: move to Done
    await vi.advanceTimersByTimeAsync(30_000)
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'In Progress',
      newColumnName: 'Done',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })

    // Advance well past the original 60s window
    await vi.advanceTimersByTimeAsync(60_000)

    // Then: original timer was cancelled
    expect(fire).not.toHaveBeenCalled()
  })
})

// ─── Assignee changes mid-debounce ────────────────────────────────────────────
describe('assignee changes mid-debounce', () => {
  it('cancels timer when a second trigger arrives for same card with a non-claude-code assignee', async () => {
    // Given
    const fire = vi.fn().mockResolvedValue(undefined)
    __setFireForTests(fire)

    // First trigger: claude-code assignee → starts timer
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: CLAUDE_CODE_ASSIGNEE,
    })

    // 30s later: same card, same column, but assignee changed to someone else
    await vi.advanceTimersByTimeAsync(30_000)
    await maybeStartExecutionDebounce({
      cardId: CARD_ID,
      prevColumnName: 'Backlog',
      newColumnName: 'In Progress',
      assigneeId: 'user-someone-else',
    })

    // Advance past the original 60s window
    await vi.advanceTimersByTimeAsync(60_000)

    // Then: original timer cancelled, no new timer started (assignee not claude-code)
    expect(fire).not.toHaveBeenCalled()
  })
})
