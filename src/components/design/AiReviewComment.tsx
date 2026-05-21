'use client'

import ReactMarkdown from 'react-markdown'
import { Avatar } from './Avatar'
import { Pip } from './Pip'
import type { PipTone } from './Pip'

const markdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p style={{ margin: '0 0 8px 0', fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55 }}>{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul style={{ margin: '0 0 8px 0', paddingLeft: 18, fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55 }}>{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol style={{ margin: '0 0 8px 0', paddingLeft: 18, fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55 }}>{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li style={{ marginBottom: 2 }}>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong style={{ color: 'var(--fg-0)', fontWeight: 600 }}>{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em>{children}</em>,
  code: ({ children }: { children?: React.ReactNode }) => (
    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-3)', padding: '1px 4px' }}>{children}</code>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} style={{ color: 'var(--accent)' }} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FindingSeverity = 'ok' | 'warn' | 'fail' | 'info' | 'note'

type Finding = {
  severity: FindingSeverity
  title: string
  body: string
}

type ParsedAiReview = {
  status: 'PASS' | 'WARN' | 'FAIL' | null
  summary: string | null
  findings: Finding[]
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Attempt to parse structured AI review content.
 *
 * Expected format (any of these markers trigger structured mode):
 *   STATUS: PASS | WARN | FAIL    (optional header line)
 *   SUMMARY: <text>               (optional summary line)
 *   [OK] / [WARN] / [FAIL] / [INFO] / [NOTE]   finding header
 *   <indented body lines>
 *
 * Also handles the legacy markdown format produced by M1/M2:
 *   **AI review of …**
 *   **Status: PASS**
 *   **Summary**: …
 *   - [WARN] title: body
 *   - [OK] title: body
 *
 * Returns null if the content does not look like a structured review.
 */
function parseAiReviewContent(content: string): ParsedAiReview | null {
  const lines = content.split('\n').map((l) => l.trim())

  // Heuristic: must have at least one severity marker to be considered structured
  const hasSeverityLine = lines.some((l) =>
    /^\[?(ok|warn|fail|info|note)\]?/i.test(l) ||
    /^[-*]\s*\[?(ok|warn|fail|info|note)\]?/i.test(l)
  )
  const hasStatusLine = lines.some((l) => /^(status|result):\s*(pass|warn|fail)/i.test(l))
  const hasBoldStatus = lines.some((l) => /\*\*status:\s*(pass|warn|fail)/i.test(l))

  if (!hasSeverityLine && !hasStatusLine && !hasBoldStatus) return null

  let status: ParsedAiReview['status'] = null
  let summary: string | null = null
  const findings: Finding[] = []
  let currentFinding: Finding | null = null

  function flushFinding() {
    if (currentFinding) findings.push(currentFinding)
    currentFinding = null
  }

  for (const line of lines) {
    // STATUS line
    const statusMatch = line.match(/^(?:\*\*)?status[:\s]+([*]*)?\s*(pass|warn|fail)/i)
    if (statusMatch) {
      const raw = statusMatch[2].toUpperCase()
      status = raw === 'PASS' ? 'PASS' : raw === 'WARN' ? 'WARN' : 'FAIL'
      continue
    }

    // SUMMARY line
    const summaryMatch = line.match(/^(?:\*\*)?summary[:\s]+(.+)/i)
    if (summaryMatch) {
      summary = summaryMatch[1].replace(/\*\*/g, '').trim()
      continue
    }

    // Skip header lines like "**AI review of …**"
    if (/^\*\*AI review of/i.test(line)) continue
    if (/^#{1,3}\s/.test(line)) continue

    // Finding header: [-*] [SEV] title   OR   [SEV] title   OR   [01] SEV title
    const findingMatch = line.match(
      /^[-*]?\s*\[?(\d{2})\]?\s*\[?(ok|warn|fail|info|note)\]?\s*[:\-–]?\s*(.+)/i
    ) ?? line.match(/^[-*]?\s*\[?(ok|warn|fail|info|note)\]?\s*[:\-–]?\s*(.+)/i)

    if (findingMatch) {
      flushFinding()
      const sevRaw: string = (findingMatch[1] && /^\d/.test(findingMatch[1])
        ? findingMatch[2]
        : findingMatch[1]).toLowerCase()
      const titleRaw = (findingMatch[3] ?? findingMatch[2]).replace(/\*\*/g, '').trim()
      const sev: FindingSeverity =
        sevRaw === 'ok' ? 'ok' :
        sevRaw === 'warn' ? 'warn' :
        sevRaw === 'fail' ? 'fail' :
        sevRaw === 'note' ? 'note' : 'info'
      currentFinding = { severity: sev, title: titleRaw, body: '' }
      continue
    }

    // Body continuation for current finding
    if (currentFinding && line) {
      currentFinding.body = currentFinding.body
        ? `${currentFinding.body} ${line}`
        : line
      continue
    }

    // First non-empty, non-header line without a finding → treat as summary
    if (!summary && line && findings.length === 0 && !currentFinding) {
      summary = line.replace(/\*\*/g, '').trim()
    }
  }

  flushFinding()

  return { status, summary, findings }
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function severityPipTone(sev: FindingSeverity): PipTone {
  if (sev === 'ok') return 'ok'
  if (sev === 'warn') return 'warn'
  if (sev === 'fail') return 'err'
  return 'default'
}

function severityColor(sev: FindingSeverity): string {
  if (sev === 'ok') return 'var(--ok)'
  if (sev === 'warn') return 'var(--warn)'
  if (sev === 'fail') return 'var(--err)'
  return 'var(--fg-3)'
}

function statusPipTone(status: ParsedAiReview['status']): PipTone {
  if (status === 'PASS') return 'ok'
  if (status === 'WARN') return 'warn'
  if (status === 'FAIL') return 'err'
  return 'default'
}

function statusColor(status: ParsedAiReview['status']): string {
  if (status === 'PASS') return 'var(--ok)'
  if (status === 'WARN') return 'var(--warn)'
  if (status === 'FAIL') return 'var(--err)'
  return 'var(--fg-3)'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AiReviewCommentProps {
  /** Raw content string from the comment row */
  content: string
  /** ISO timestamp string */
  createdAt: string
  /** Agent / system identifier (e.g. "ai-reviewer") */
  agentId: string
}

/**
 * Renders an AI Reviewer comment in the canonical "structured findings" style (option C).
 * Parses structured content (STATUS + SUMMARY + numbered findings) and renders with
 * severity pips. Falls back to plain text if the content is not structured.
 */
export function AiReviewComment({ content, createdAt, agentId }: AiReviewCommentProps) {
  const parsed = parseAiReviewContent(content)
  const timeLabel = new Date(createdAt).toLocaleString()

  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <Avatar ai size="md" />
      <div style={{ flex: 1 }}>
        {/* Header row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            marginBottom: 6,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{ fontSize: 13, color: 'var(--fg-0)', fontWeight: 500, fontFamily: 'var(--font-body)' }}
          >
            AI Reviewer
          </span>
          <span
            className="km-mono"
            style={{
              fontSize: 9,
              color: 'var(--fg-3)',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              padding: '0 5px',
              border: '1px solid var(--line)',
            }}
          >
            AI
          </span>
          <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
            · {agentId} · {timeLabel}
          </span>
          {parsed?.status && (
            <>
              <span style={{ flex: 1 }} />
              <span
                className="km-mono"
                style={{
                  fontSize: 10,
                  color: statusColor(parsed.status),
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <Pip tone={statusPipTone(parsed.status)} />
                {parsed.status}
              </span>
            </>
          )}
        </div>

        {/* Structured body */}
        {parsed ? (
          <>
            {parsed.summary && (
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--fg-1)',
                  lineHeight: 1.55,
                  paddingBottom: 8,
                  borderBottom: '1px solid var(--line-faint)',
                  marginBottom: 6,
                }}
              >
                {parsed.summary}
              </div>
            )}
            {parsed.findings.map((f, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '16px 1fr',
                  gap: 8,
                  padding: '6px 0',
                  borderTop: i === 0 ? 0 : '1px solid var(--line-faint)',
                }}
              >
                <div style={{ paddingTop: 6 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 7,
                      height: 7,
                      background: severityColor(f.severity),
                    }}
                  />
                </div>
                <div>
                  <div
                    className="km-mono"
                    style={{
                      fontSize: 10,
                      color: severityColor(f.severity),
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                    }}
                  >
                    [{String(i + 1).padStart(2, '0')}] {f.severity}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: 'var(--fg-0)',
                      marginTop: 2,
                      fontWeight: 500,
                      letterSpacing: '-0.005em',
                      fontFamily: 'var(--font-body)',
                    }}
                  >
                    {f.title}
                  </div>
                  {f.body && (
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--fg-2)',
                        marginTop: 2,
                        lineHeight: 1.5,
                        fontFamily: 'var(--font-body)',
                      }}
                    >
                      {f.body}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {parsed.findings.length === 0 && !parsed.summary && (
              <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55 }}>
                <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
              </div>
            )}
          </>
        ) : (
          // Fallback: render markdown
          <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55 }}>
            <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
