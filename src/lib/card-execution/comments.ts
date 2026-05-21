async function db() {
  const mod = await import('@/lib/db')
  return mod.prisma
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
