'use client'

import { Chip } from '@/components/design/Chip'
import { Eyebrow } from '@/components/design/Eyebrow'
import { Composer } from './Composer'
import { DayBrief } from './DayBrief'
import { safeHttpUrl, safeItemUrl } from '@/lib/planner/types'
import type { RankedItemDTO, TodayResponse } from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §7.3 "Workspace".

export interface WorkspaceProps {
  item: RankedItemDTO | null
  brief: TodayResponse['brief']
  orgId: string
}

function externalLinkLabel(source: RankedItemDTO['source']): string | null {
  if (source === 'email') return 'open in gmail'
  if (source === 'calendar') return 'open event'
  if (source === 'slack') return 'open in slack'
  return null
}

export function Workspace({ item, brief, orgId }: WorkspaceProps) {
  if (!item) {
    return (
      <section
        aria-label="workspace"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <Eyebrow size={10}>{'/// workspace'}</Eyebrow>
        <DayBrief brief={brief} />
      </section>
    )
  }

  const boardId = typeof item.payload.boardId === 'string' ? item.payload.boardId : null
  const cardId = typeof item.payload.cardId === 'string' ? item.payload.cardId : null
  const cardHref =
    item.source === 'card'
      ? safeItemUrl(item.url)
      : boardId && cardId
        ? safeItemUrl(`/board/${boardId}?card=${cardId}`)
        : null
  const extLabel = externalLinkLabel(item.source)
  const extHref = extLabel ? safeHttpUrl(item.url) : null

  return (
    <section
      aria-label="workspace"
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minHeight: 0,
        overflow: 'auto',
      }}
    >
      <Eyebrow size={10}>{'/// workspace'}</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <Chip>{item.source}</Chip>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg-0)', margin: 0 }}>
          {item.title}
        </h2>
      </div>
      <div style={{ display: 'flex', gap: 14 }}>
        {extHref && (
          <a
            href={extHref}
            target="_blank"
            rel="noreferrer"
            className="km-mono"
            style={{ fontSize: 11, color: 'var(--accent)' }}
          >
            {extLabel}
          </a>
        )}
        {cardHref && (
          <a href={cardHref} className="km-mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
            open card
          </a>
        )}
      </div>
      {item.prepNotes && (
        <div>
          <Eyebrow size={9}>{'/// prep'}</Eyebrow>
          <p style={{ fontSize: 12, color: 'var(--fg-1)', lineHeight: 1.55, marginTop: 4 }}>
            {item.prepNotes}
          </p>
        </div>
      )}
      <Composer item={item} orgId={orgId} />
    </section>
  )
}
