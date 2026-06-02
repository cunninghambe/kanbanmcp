'use client'

import { useId, useRef, useState } from 'react'
import { Link2 } from 'lucide-react'

interface Props {
  cardId: string
  onAttached: () => void
}

type RejectedItem = { id: string; name?: string; reason: string }

type Status =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'error'; message: string; code?: string; fileId?: string; settingsLink?: boolean }
  | { phase: 'partial'; summary: string; rejected: RejectedItem[] }
  | { phase: 'success'; summary: string }

type GoogleAttachBody = { url: string }

type GoogleAttachResponse =
  | { error: 'INVALID_URL' }
  | { error: 'NOT_CONNECTED' }
  | { error: 'FORBIDDEN'; fileId?: string }
  | { error: 'TRASHED'; fileId?: string }
  | { error: 'NOT_FOUND'; fileId?: string }
  | { error: 'UNSUPPORTED_TYPE' }
  | { error: 'PARTIAL_FOLDER'; folder: unknown; files: unknown[]; rejected: RejectedItem[] }
  | { error: 'GOOGLE_HTTP_ERROR' }
  | { artifact: unknown; expandedArtifacts?: unknown[] }

function isDriveUrl(value: string): boolean {
  return value.includes('drive.google.com') || value.includes('docs.google.com')
}

export function AttachGoogleLink({ cardId, onAttached }: Props) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<Status>({ phase: 'idle' })
  const [rejectedOpen, setRejectedOpen] = useState(false)

  async function submit(rawUrl: string) {
    const trimmed = rawUrl.trim()
    if (!trimmed) return

    setStatus({ phase: 'submitting' })
    setRejectedOpen(false)

    const body: GoogleAttachBody = { url: trimmed }

    let res: Response
    try {
      res = await fetch(`/api/cards/${cardId}/artifacts/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      setStatus({ phase: 'error', message: 'Google was unreachable. Try again in a moment.' })
      return
    }

    if (res.status === 201) {
      const data = (await res.json()) as GoogleAttachResponse
      const expanded = 'expandedArtifacts' in data && Array.isArray(data.expandedArtifacts)
        ? data.expandedArtifacts.length
        : 0
      const summary = expanded > 0 ? `Attached folder + ${expanded} file${expanded === 1 ? '' : 's'}.` : 'Attached.'
      setUrl('')
      setStatus({ phase: 'success', summary })
      onAttached()
      setTimeout(() => {
        setStatus({ phase: 'idle' })
        inputRef.current?.focus()
      }, 2000)
      return
    }

    let data: GoogleAttachResponse
    try {
      data = (await res.json()) as GoogleAttachResponse
    } catch {
      setStatus({ phase: 'error', message: 'Google was unreachable. Try again in a moment.' })
      return
    }

    if (!('error' in data)) {
      setStatus({ phase: 'error', message: 'Google was unreachable. Try again in a moment.' })
      return
    }

    if (data.error === 'INVALID_URL') {
      setStatus({ phase: 'error', message: "That doesn't look like a Drive URL.", code: 'INVALID_URL' })
      return
    }
    if (data.error === 'NOT_CONNECTED') {
      setStatus({ phase: 'error', message: 'Connect Google in Settings to attach Drive content.', code: 'NOT_CONNECTED', settingsLink: true })
      return
    }
    if (data.error === 'FORBIDDEN') {
      const fid = 'fileId' in data ? data.fileId : undefined
      const msg = fid
        ? `You don't have access to that file in Google (file id: ${fid}).`
        : "You don't have access to that file in Google."
      setStatus({ phase: 'error', message: msg, code: 'FORBIDDEN', fileId: fid })
      return
    }
    if (data.error === 'TRASHED' || data.error === 'NOT_FOUND') {
      const fid = 'fileId' in data ? data.fileId : undefined
      const msg = fid
        ? `File not found or in trash (file id: ${fid}).`
        : 'File not found or in trash.'
      setStatus({ phase: 'error', message: msg, code: data.error, fileId: fid })
      return
    }
    if (data.error === 'UNSUPPORTED_TYPE') {
      setStatus({ phase: 'error', message: "That file type isn't supported (Docs, Sheets, Slides, folders only).", code: 'UNSUPPORTED_TYPE' })
      return
    }
    if (data.error === 'PARTIAL_FOLDER') {
      const attached = 'files' in data && Array.isArray(data.files) ? data.files.length : 0
      const summary = `Attached ${attached} file${attached === 1 ? '' : 's'}. Some items were skipped.`
      setStatus({ phase: 'partial', summary, rejected: data.rejected })
      onAttached()
      return
    }

    setStatus({ phase: 'error', message: 'Google was unreachable. Try again in a moment.' })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit(url)
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text')
    if (isDriveUrl(pasted)) {
      e.preventDefault()
      const newUrl = pasted.trim()
      setUrl(newUrl)
      void submit(newUrl)
    }
  }

  const isSubmitting = status.phase === 'submitting'
  const submitDisabled = isSubmitting || url.trim().length === 0

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor={inputId} className="sr-only">
          Google Drive URL
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="url"
          value={url}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="https://docs.google.com/document/d/..."
          disabled={isSubmitting}
          className="km-mono"
          style={{
            fontSize: 11,
            color: 'var(--fg-2)',
            flex: 1,
            minWidth: 0,
            background: 'var(--bg-2)',
            border: '1px solid var(--line)',
            padding: '4px 8px',
            outline: 'none',
          }}
          aria-label="Google Drive URL"
        />
        <button
          type="button"
          onClick={() => void submit(url)}
          disabled={submitDisabled}
          className="km-btn km-btn--sm"
          style={{ opacity: submitDisabled ? 0.5 : 1, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}
          aria-label="Attach Google Drive link"
        >
          <Link2 size={11} />
          {isSubmitting ? 'Attaching…' : 'Attach'}
        </button>
      </div>

      {status.phase === 'error' && (
        <p
          role="alert"
          aria-live="assertive"
          style={{ fontSize: 12, color: 'var(--err)', marginTop: 6, marginBottom: 0 }}
        >
          {status.message}
          {status.settingsLink && (
            <>
              {' '}
              <a
                href="/settings/integrations"
                style={{ color: 'var(--accent)', textDecoration: 'underline' }}
              >
                Connect Google
              </a>
            </>
          )}
        </p>
      )}

      {status.phase === 'success' && (
        <p
          role="status"
          aria-live="polite"
          style={{ fontSize: 12, color: 'var(--ok)', marginTop: 6, marginBottom: 0 }}
        >
          {status.summary}
        </p>
      )}

      {status.phase === 'partial' && (
        <div style={{ marginTop: 6 }}>
          <p
            role="alert"
            aria-live="assertive"
            style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 4 }}
          >
            {status.summary}
          </p>
          <button
            type="button"
            onClick={() => setRejectedOpen((o) => !o)}
            className="km-mono"
            style={{
              fontSize: 10,
              color: 'var(--accent)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              textDecoration: 'underline',
            }}
            aria-expanded={rejectedOpen}
          >
            {rejectedOpen ? 'Hide skipped' : `Show skipped (${status.rejected.length})`}
          </button>
          {rejectedOpen && (
            <ul
              style={{ marginTop: 4, paddingLeft: 14, fontSize: 11, color: 'var(--fg-3)' }}
              aria-label="Skipped files"
            >
              {status.rejected.map((item) => (
                <li key={item.id} className="km-mono">
                  {item.name ?? item.id} — {item.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
