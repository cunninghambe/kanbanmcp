'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Chip } from '@/components/design/Chip'
import styles from '../hud.module.css'

export type EntryKind = 'agenda' | 'note' | 'decision' | 'action'

export type Entry = {
  id: string
  kind: EntryKind
  text: string
  position: number
  checkedAt: string | null
  assigneeId: string | null
  assigneeName: string | null
  dueDate: string | null
  cardId: string | null
  createdAt: string
}

type CaptureKind = 'action' | 'note' | 'decision'
type AssigneeResolution = 'resolved' | 'none' | 'ambiguous'
type Candidate = { id: string; name: string }

type PostEntryResponse = {
  entry: Entry
  assigneeResolution?: AssigneeResolution
  candidates?: Candidate[]
}

const CAPTURE_KINDS: { key: CaptureKind; label: string }[] = [
  { key: 'action', label: 'action' },
  { key: 'note', label: 'note' },
  { key: 'decision', label: 'decision' },
]

type JSONResult<T> = { ok: true; data: T } | { ok: false; data: { error?: string } }

/** POSTs/PATCHes JSON. A rejected fetch (network failure) is caught and
 * reported through the same `ok: false` shape as a non-2xx response, so
 * every call site has one failure path. The five entry-mutation call sites
 * below all use this. */
async function requestJSON<T>(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<JSONResult<T>> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, data: {} }
  }
  const data = await res.json().catch(() => ({}))
  return res.ok ? { ok: true, data: data as T } : { ok: false, data: data as { error?: string } }
}

export function MeetingPanel({
  sessionId,
  live,
  boardId,
  entries,
  onMutate,
}: {
  sessionId: string
  live: boolean
  boardId: string | null
  entries: Entry[]
  onMutate: () => void
}) {
  const agendaEntries = entries.filter((e) => e.kind === 'agenda')
  const logEntries = entries
    .filter((e) => e.kind !== 'agenda')
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return (
    <>
      <div className={styles.sectionHead}>
        <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>
          {'/// meeting'}
        </span>
      </div>

      <AgendaSection sessionId={sessionId} live={live} entries={agendaEntries} onMutate={onMutate} />
      <CaptureSection sessionId={sessionId} live={live} onMutate={onMutate} />
      <LogSection boardId={boardId} entries={logEntries} onMutate={onMutate} />
    </>
  )
}

function AgendaSection({
  sessionId,
  live,
  entries,
  onMutate,
}: {
  sessionId: string
  live: boolean
  entries: Entry[]
  onMutate: () => void
}) {
  const [text, setText] = useState('')

  async function toggle(entry: Entry) {
    await requestJSON(`/api/hud/entries/${entry.id}`, 'PATCH', { checked: !entry.checkedAt })
    onMutate()
  }

  async function add() {
    const value = text.trim()
    if (!value || !live) return
    const { ok } = await requestJSON<PostEntryResponse>(`/api/hud/${sessionId}/entries`, 'POST', {
      kind: 'agenda',
      text: value,
    })
    onMutate()
    if (ok) setText('')
  }

  return (
    <div className={styles.mpSection}>
      <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
        agenda
      </span>

      {entries.length === 0 && (
        <p className={styles.mpHint}>no agenda items yet.</p>
      )}

      {entries.map((entry) => (
        <label key={entry.id} className={styles.mpAgendaItem}>
          <input type="checkbox" checked={!!entry.checkedAt} onChange={() => toggle(entry)} />
          <span>{entry.text}</span>
        </label>
      ))}

      <div className={styles.mpAddRow}>
        <input
          className="km-input"
          aria-label="Add agenda item"
          placeholder="add agenda item…"
          value={text}
          disabled={!live}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
      </div>
    </div>
  )
}

function CaptureSection({
  sessionId,
  live,
  onMutate,
}: {
  sessionId: string
  live: boolean
  onMutate: () => void
}) {
  const [kind, setKind] = useState<CaptureKind>('action')
  const [text, setText] = useState('')
  const [ambiguous, setAmbiguous] = useState<{ entryId: string; candidates: Candidate[] } | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)

  async function submit() {
    const value = text.trim()
    if (!value || !live) return
    const { ok, data } = await requestJSON<PostEntryResponse>(`/api/hud/${sessionId}/entries`, 'POST', {
      kind,
      text: value,
    })
    if (ok) {
      setText('')
      setPickError(null)
      setAmbiguous(
        data.assigneeResolution === 'ambiguous' && data.candidates
          ? { entryId: data.entry.id, candidates: data.candidates }
          : null
      )
    }
    onMutate()
  }

  async function pickCandidate(candidate: Candidate) {
    if (!ambiguous) return
    const { ok, data } = await requestJSON(`/api/hud/entries/${ambiguous.entryId}`, 'PATCH', {
      assigneeId: candidate.id,
    })
    if (!ok) {
      setPickError(data.error ?? 'Could not assign — try again')
      return
    }
    setAmbiguous(null)
    setPickError(null)
    onMutate()
  }

  return (
    <div className={styles.mpSection}>
      <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
        capture
      </span>

      <div className={styles.segs} role="group" aria-label="capture kind">
        {CAPTURE_KINDS.map((k) => (
          <button
            key={k.key}
            type="button"
            className={styles.seg}
            aria-pressed={kind === k.key}
            disabled={!live}
            onClick={() => setKind(k.key)}
          >
            {k.label}
          </button>
        ))}
      </div>

      <input
        className="km-input"
        aria-label="Capture note, decision, or action"
        placeholder={live ? 'capture what was just said…' : 'session ended — capture disabled'}
        value={text}
        disabled={!live}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
      />

      {kind === 'action' && <p className={styles.mpHint}>@name due:fri · tokens parse to assignee/due</p>}

      {ambiguous && (
        <div className={styles.mpCandidates} aria-live="polite">
          {ambiguous.candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              className={styles.mpCandidate}
              aria-label={`Assign to ${c.name}`}
              onClick={() => pickCandidate(c)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {pickError && (
        <p role="alert" className={styles.mpRowError}>
          {pickError}
        </p>
      )}
    </div>
  )
}

function LogSection({
  boardId,
  entries,
  onMutate,
}: {
  boardId: string | null
  entries: Entry[]
  onMutate: () => void
}) {
  const [convertErrors, setConvertErrors] = useState<Record<string, string>>({})

  async function convert(entry: Entry) {
    const { ok, data } = await requestJSON<{ entry: Entry; card: { id: string } }>(
      `/api/hud/entries/${entry.id}/card`,
      'POST',
      {}
    )
    if (!ok) {
      setConvertErrors((prev) => ({ ...prev, [entry.id]: data.error ?? 'Could not create card' }))
      return
    }
    setConvertErrors((prev) => {
      if (!(entry.id in prev)) return prev
      const rest = { ...prev }
      delete rest[entry.id]
      return rest
    })
    onMutate()
  }

  return (
    <div className={styles.mpSection}>
      <span className="km-eyebrow" style={{ fontSize: 9, color: 'var(--fg-3)' }}>
        log
      </span>

      {entries.length === 0 && <p className={styles.mpHint}>nothing captured yet.</p>}

      {entries.map((entry) => (
        <div key={entry.id} className={styles.mpRow}>
          <div className={styles.mpRowHead}>
            <span className={styles.mpKind}>{entry.kind}</span>
            <span className={styles.mpRowText}>{entry.text}</span>
          </div>

          {entry.kind === 'action' && (
            <div className={styles.mpRowMeta}>
              {entry.assigneeId && <Chip>{entry.assigneeName ? `@${entry.assigneeName}` : 'assigned'}</Chip>}
              {entry.dueDate && <Chip>due {entry.dueDate.slice(0, 10)}</Chip>}
              {boardId && !entry.cardId && (
                <button
                  type="button"
                  className="km-btn km-btn--sm"
                  aria-label={`Create card for "${entry.text}"`}
                  onClick={() => convert(entry)}
                >
                  → card
                </button>
              )}
              {boardId && entry.cardId && (
                <Link href={`/board/${boardId}`} className="km-mono" style={{ fontSize: 10, color: 'var(--accent)' }}>
                  view card →
                </Link>
              )}
            </div>
          )}

          {convertErrors[entry.id] && (
            <p role="alert" className={styles.mpRowError}>
              {convertErrors[entry.id]}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
