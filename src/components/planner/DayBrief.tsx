'use client'

import ReactMarkdown from 'react-markdown'
import { plannerMarkdownComponents } from './markdown'
import type { TodayResponse } from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §7.3 "Workspace" (empty state).

export interface DayBriefProps {
  brief: TodayResponse['brief']
}

export function DayBrief({ brief }: DayBriefProps) {
  if (!brief) {
    return (
      <div>
        <p className="km-mono" style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.6 }}>
          plan my day writes a short brief and prep notes for your top items.
        </p>
        <p className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.6 }}>
          Select a row on the left to open it here, draft a reply or document, and hand it off.
        </p>
      </div>
    )
  }
  return (
    <div>
      <ReactMarkdown components={plannerMarkdownComponents}>{brief.text}</ReactMarkdown>
    </div>
  )
}
