// Memoize the import promise so concurrent callers share one dynamic import
// (avoids redundant imports and a concurrent-dynamic-import race vs test mocks).
let prismaPromise: Promise<(typeof import('@/lib/db'))['prisma']> | null = null

async function db() {
  if (!prismaPromise) {
    prismaPromise = import('@/lib/db').then((mod) => mod.prisma)
  }
  return prismaPromise
}

export async function postExecutionComment(cardId: string, content: string): Promise<void> {
  const prisma = await db()
  await prisma.comment.create({
    data: { cardId, userId: 'agent-claude-code', content },
  })
}

export async function postProtocolWarningComment(cardId: string): Promise<void> {
  const prisma = await db()
  await prisma.comment.create({
    data: {
      cardId,
      userId: 'agent-claude-code',
      content: '[M3 protocol warning] Claude did not output a DELIVERABLES: line. No artifacts were attached. Reviewing manually.',
    },
  })
}

export async function postDeliverySummaryComment(
  cardId: string,
  summary: string,
  attached: Array<{ filename: string; artifactId?: string }>,
  rejectedOrSkipped: Array<{ path: string; reason: string }>,
): Promise<void> {
  const prisma = await db()
  const parts: string[] = ['**Claude Code delivered:**', '', summary]

  if (attached.length > 0) {
    parts.push('', '**Attached:**')
    for (const a of attached) {
      const link = a.artifactId
        ? `[${a.filename}](/api/artifacts/${a.artifactId}/download)`
        : a.filename
      parts.push(`- ${link}`)
    }
  }

  if (rejectedOrSkipped.length > 0) {
    parts.push('', '**Skipped or rejected:**')
    for (const r of rejectedOrSkipped) parts.push(`- ${r.path} (${r.reason})`)
  }

  await prisma.comment.create({
    data: { cardId, userId: 'agent-claude-code', content: parts.join('\n') },
  })
}
