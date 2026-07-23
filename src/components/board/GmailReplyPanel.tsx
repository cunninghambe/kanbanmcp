'use client'

import { useRef, useState } from 'react'

interface GmailReplyPanelProps {
  cardId: string
  threadId: string
}

type PanelState = 'compose' | 'drafting' | 'preview' | 'sent'

interface DraftPreview {
  draftId: string
  preview: string
  to: string
}

// Minimal typing for the (non-standard, still experimental) Web Speech API —
// lib.dom.d.ts ships the result/alternative shapes but not the recognizer
// itself or its constructor, so we declare only what we use here.
interface SpeechRecognitionEventLike {
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: Event) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

/**
 * Voice-note → agent draft → one-tap approve, rendered on cards tagged
 * `gmail:<threadId>` in their description. Talks only to /api/inbox-agent
 * (the human-session-only proxy that holds the Apps Script token
 * server-side) and, once sent, leaves a card comment for provenance.
 */
export function GmailReplyPanel({ cardId, threadId }: GmailReplyPanelProps) {
  const [state, setState] = useState<PanelState>('compose')
  const [instructions, setInstructions] = useState('')
  const [replyAll, setReplyAll] = useState(false)
  const [listening, setListening] = useState(false)
  const [preview, setPreview] = useState<DraftPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unconfigured, setUnconfigured] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  const SpeechRecognitionCtor = getSpeechRecognitionCtor()

  function toggleMic() {
    if (!SpeechRecognitionCtor) return
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }
    const recognition = new SpeechRecognitionCtor()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-US'
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((r) => r[0]?.transcript ?? '')
        .join(' ')
        .trim()
      if (transcript) {
        setInstructions((prev) => (prev ? `${prev} ${transcript}` : transcript))
      }
    }
    recognition.onerror = () => setListening(false)
    recognition.onend = () => setListening(false)
    recognitionRef.current = recognition
    setListening(true)
    recognition.start()
  }

  async function handleDraft() {
    if (!instructions.trim()) return
    setError(null)
    setUnconfigured(false)
    setState('drafting')
    try {
      const res = await fetch('/api/inbox-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'draft', threadId, instructions: instructions.trim(), replyAll }),
      })
      if (res.status === 503) {
        setUnconfigured(true)
        setState('compose')
        return
      }
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(typeof data.error === 'string' ? data.error : 'Draft failed — try again.')
        setState('compose')
        return
      }
      setPreview({ draftId: data.draftId, preview: data.preview, to: data.to })
      setState('preview')
    } catch {
      setError('Draft failed — try again.')
      setState('compose')
    }
  }

  async function handleSend() {
    if (!preview) return
    setError(null)
    try {
      const res = await fetch('/api/inbox-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', draftId: preview.draftId }),
      })
      if (res.status === 503) {
        setUnconfigured(true)
        return
      }
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(typeof data.error === 'string' ? data.error : 'Send failed — try again.')
        return
      }
      setState('sent')
      fetch(`/api/cards/${cardId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `Replied via inbox agent — ${preview.to}` }),
      }).catch(() => {})
    } catch {
      setError('Send failed — try again.')
    }
  }

  function handleRedraft() {
    setPreview(null)
    setError(null)
    setState('compose')
  }

  function handleDiscard() {
    setPreview(null)
    setError(null)
    setState('compose')
  }

  return (
    <section aria-labelledby="gmail-reply-heading" style={{ padding: '16px 28px', borderBottom: '1px solid var(--line)' }}>
      <h3 id="gmail-reply-heading" className="km-eyebrow" style={{ fontSize: 9, margin: '0 0 10px 0', fontWeight: 500 }}>
        {'/// gmail reply'}
      </h3>

      {unconfigured && (
        <p className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)', margin: '0 0 8px 0' }}>
          inbox agent not configured
        </p>
      )}
      {error && (
        <p className="km-mono" style={{ fontSize: 11, color: 'var(--err)', margin: '0 0 8px 0' }}>
          {error}
        </p>
      )}

      {(state === 'compose' || state === 'drafting') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <textarea
              className="km-input"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="voice-note or type what to say…"
              disabled={state === 'drafting'}
              style={{ minHeight: 80, height: 'auto', resize: 'vertical', paddingRight: SpeechRecognitionCtor ? 40 : undefined }}
            />
            {SpeechRecognitionCtor && (
              <button
                type="button"
                onClick={toggleMic}
                aria-pressed={listening}
                aria-label={listening ? 'Stop voice input' : 'Start voice input'}
                disabled={state === 'drafting'}
                className="km-btn km-btn--ghost km-btn--sm"
                style={{ position: 'absolute', top: 4, right: 4, color: listening ? 'var(--accent)' : 'var(--fg-2)' }}
              >
                🎤
              </button>
            )}
          </div>
          <label className="km-mono" style={{ fontSize: 11, color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={replyAll}
              onChange={(e) => setReplyAll(e.target.checked)}
              disabled={state === 'drafting'}
            />
            reply all
          </label>
          <div>
            <button
              type="button"
              onClick={handleDraft}
              disabled={state === 'drafting' || !instructions.trim()}
              className="km-btn km-btn--primary km-btn--sm"
            >
              {state === 'drafting' ? 'drafting…' : 'draft reply'}
            </button>
          </div>
        </div>
      )}

      {state === 'preview' && preview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>
            to: {preview.to}
          </span>
          <div
            style={{
              border: '1px solid var(--line)',
              background: 'var(--bg-1)',
              padding: '10px 12px',
              fontSize: 13,
              lineHeight: 1.5,
              color: 'var(--fg-0)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {preview.preview}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={handleSend} className="km-btn km-btn--primary km-btn--sm">
              approve &amp; send
            </button>
            <button type="button" onClick={handleRedraft} className="km-btn km-btn--sm">
              re-draft
            </button>
            <button type="button" onClick={handleDiscard} className="km-btn km-btn--ghost km-btn--sm">
              discard
            </button>
          </div>
        </div>
      )}

      {state === 'sent' && preview && (
        <p className="km-mono" style={{ fontSize: 12, color: 'var(--ok)', margin: 0 }}>
          ● sent to {preview.to}
        </p>
      )}
    </section>
  )
}
