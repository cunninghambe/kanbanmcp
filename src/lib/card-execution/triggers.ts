import { prisma } from '@/lib/db'

export const DEBOUNCE_MS = 60_000
export const CLAUDE_CODE_AGENT_USER_ID = 'agent-claude-code'

const timers = new Map<string, NodeJS.Timeout>()

let fireFnOverride: ((cardId: string) => Promise<void>) | null = null

function cancelTimer(cardId: string): void {
  const existing = timers.get(cardId)
  if (existing !== undefined) {
    clearTimeout(existing)
    timers.delete(cardId)
  }
}

async function defaultFire(cardId: string): Promise<void> {
  // Dynamic import avoids circular dependency; worker.ts may import from triggers.ts.
  const { fireExecutionForCard } = await import('./worker')
  await fireExecutionForCard(cardId)
}

export async function maybeStartExecutionDebounce(input: {
  cardId: string
  prevColumnName: string | null
  newColumnName: string
  assigneeId: string | null
}): Promise<void> {
  const { cardId, newColumnName, assigneeId } = input

  cancelTimer(cardId)

  const isInProgress = newColumnName.toLowerCase() === 'in progress'
  if (!isInProgress || assigneeId !== CLAUDE_CODE_AGENT_USER_ID) return

  const [card, activeExecution] = await Promise.all([
    prisma.card.findUnique({ where: { id: cardId }, select: { description: true } }),
    prisma.cardExecution.findFirst({ where: { cardId, state: { in: ['enqueued', 'running'] } } }),
  ])

  const description = card?.description ?? null
  if (!description || description.trim() === '') return
  if (activeExecution !== null) return

  const timer = setTimeout(() => {
    timers.delete(cardId)
    const fn = fireFnOverride ?? defaultFire
    fn(cardId).catch((err: unknown) => {
      console.error(`[card-execution] fireExecutionForCard failed for ${cardId}:`, err)
    })
  }, DEBOUNCE_MS)

  timers.set(cardId, timer)
}

export function __setFireForTests(fn: ((cardId: string) => Promise<void>) | null): void {
  fireFnOverride = fn
}

export function resetTimersForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  fireFnOverride = null
}
