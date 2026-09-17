'use client'

import { Chip } from '@/components/design/Chip'
import type {
  CollectedSource,
  SourceStatus as SourceStatusValue,
  TodayResponse,
} from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §7.4 "SourceStatus".

const ORDER: CollectedSource[] = ['card', 'email', 'calendar', 'slack']

function statusLabel(status: SourceStatusValue): string {
  if (status === 'ok') return 'ok'
  if (status === 'error') return 'error'
  if (status === 'needs_scope') return 'needs google upgrade'
  return 'not connected'
}

export function SourceStatus({
  sources,
  sourceErrors,
}: Pick<TodayResponse, 'sources' | 'sourceErrors'>) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {ORDER.map((source) => {
        const status = sources[source]
        const label = `${source} · ${statusLabel(status)}`
        if (status === 'ok') {
          return (
            <Chip key={source} tone="ok">
              {label}
            </Chip>
          )
        }
        if (status === 'error') {
          return (
            <span key={source} title={sourceErrors[source]} className="km-chip km-chip--err">
              {label}
            </span>
          )
        }
        if (status === 'needs_scope') {
          return (
            <a
              key={source}
              href="/api/me/google/connect?upgrade=planner"
              style={{ textDecoration: 'none' }}
            >
              <Chip>{label}</Chip>
            </a>
          )
        }
        return (
          <a key={source} href="/settings/integrations" style={{ textDecoration: 'none' }}>
            <Chip>{label}</Chip>
          </a>
        )
      })}
    </div>
  )
}
