'use client'

import type { ReactNode } from 'react'
import { safeHttpUrl } from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §1.4 invariant 6 and §7.4. Copy of
// AiReviewComment's restricted component map (src/components/design/AiReviewComment.tsx)
// plus h1–h3, blockquote and pre. Untrusted text (email/Slack/calendar/model
// output) is rendered through this map only — links are dropped to plain
// text unless safeHttpUrl accepts them.

export const plannerMarkdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg-0)', margin: '0 0 8px 0' }}>
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg-0)', margin: '0 0 8px 0' }}>
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-0)', margin: '0 0 8px 0' }}>
      {children}
    </h3>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p style={{ margin: '0 0 8px 0', fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55 }}>
      {children}
    </p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul
      style={{
        margin: '0 0 8px 0',
        paddingLeft: 18,
        fontSize: 13,
        color: 'var(--fg-1)',
        lineHeight: 1.55,
      }}
    >
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol
      style={{
        margin: '0 0 8px 0',
        paddingLeft: 18,
        fontSize: 13,
        color: 'var(--fg-1)',
        lineHeight: 1.55,
      }}
    >
      {children}
    </ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li style={{ marginBottom: 2 }}>{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong style={{ color: 'var(--fg-0)', fontWeight: 600 }}>{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => <em>{children}</em>,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote
      style={{
        margin: '0 0 8px 0',
        padding: '2px 0 2px 10px',
        borderLeft: '2px solid var(--line-strong)',
        color: 'var(--fg-2)',
        fontSize: 13,
      }}
    >
      {children}
    </blockquote>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <code
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        background: 'var(--bg-3)',
        padding: '1px 4px',
      }}
    >
      {children}
    </code>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        background: 'var(--bg-3)',
        padding: 10,
        overflowX: 'auto',
        margin: '0 0 8px 0',
      }}
    >
      {children}
    </pre>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    // Render the href as given (not the normalized safeHttpUrl() return
    // value) once it clears the scheme allowlist, so an already-clean URL is
    // never mangled (e.g. a trailing slash added to a bare origin).
    if (!safeHttpUrl(href)) return <>{children}</>
    return (
      <a href={href} style={{ color: 'var(--accent)' }} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  },
}
