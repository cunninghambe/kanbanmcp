'use client'

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { plannerMarkdownComponents } from './markdown'
import { safeHttpUrl, safeItemUrl } from '@/lib/planner/types'
import type {
  PendingEmail,
  PlannerDraftDTO,
  PlannerHandoffRecord,
  RankedItemDTO,
} from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §7.3 "HandoffBar" and §7.4.

export interface HandoffBarProps {
  item: RankedItemDTO
  draft: PlannerDraftDTO
  body: string
  orgId: string
  /** Composer's "cancel debounce + await pending PATCH"; false when the save failed. */
  flush: () => Promise<boolean | void>
  onDraftChange: (draft: PlannerDraftDTO) => void
}

interface Board {
  id: string
  name: string
}

type GdocIssue = { kind: 'scopes'; url: string } | { kind: 'not_connected' } | null

const UPGRADE_URL_DEFAULT = '/api/me/google/connect?upgrade=planner'

/** Only an app-relative path from the API becomes an href; anything else falls back. */
function sameOriginPath(value: unknown): string {
  return typeof value === 'string' && /^\/(?![\/\\])/.test(value) ? value : UPGRADE_URL_DEFAULT
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatHHMM(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function HandoffBar({ item, draft, body, orgId, flush, onDraftChange }: HandoffBarProps) {
  const bodyEmpty = body.trim() === ''

  const [handoffRecord, setHandoffRecord] = useState<PlannerHandoffRecord | null>(draft.handoff)
  const [generalError, setGeneralError] = useState<string | null>(null)

  // email two-step
  const [emailPhase, setEmailPhase] = useState<'idle' | 'previewing'>('idle')
  const [previewInfo, setPreviewInfo] = useState<{
    to: string
    cc: string
    /** the composed text as the server holds it; null when the API did not echo it */
    preview: string | null
  } | null>(null)
  const [composedBody, setComposedBody] = useState<string | null>(null)
  const [emailMessage, setEmailMessage] = useState<string | null>(null)
  const [emailDisabled, setEmailDisabled] = useState(false)
  const [sending, setSending] = useState(false)
  const [showEmailForm, setShowEmailForm] = useState(false)
  const [emailTo, setEmailTo] = useState('')
  const [emailSubject, setEmailSubject] = useState('')

  // gdoc
  const [gdocIssue, setGdocIssue] = useState<GdocIssue>(null)

  // slack
  const [showSlackForm, setShowSlackForm] = useState(false)
  const [slackChannel, setSlackChannel] = useState('')
  const [slackNotConnected, setSlackNotConnected] = useState(false)

  // create card
  const [showCardCreateForm, setShowCardCreateForm] = useState(false)
  const [boards, setBoards] = useState<Board[]>([])
  const [selectedBoardId, setSelectedBoardId] = useState('')

  const cardId = typeof item.payload.cardId === 'string' ? item.payload.cardId : null

  // Switching drafts resets every per-draft form/message. Any body edit
  // (typing, a generate result) or a draft switch away from the composed
  // snapshot discards a held email preview.
  /* eslint-disable react-hooks/set-state-in-effect */
  const prevDraftIdRef = useRef(draft.id)
  useEffect(() => {
    if (prevDraftIdRef.current === draft.id) return
    prevDraftIdRef.current = draft.id
    setShowEmailForm(false)
    setEmailTo('')
    setEmailSubject('')
    setGdocIssue(null)
    setSlackNotConnected(false)
    setShowSlackForm(false)
    setSlackChannel('')
    setShowCardCreateForm(false)
    setSelectedBoardId('')
    setGeneralError(null)
    setHandoffRecord(draft.handoff)
    if (emailPhase === 'previewing') {
      setEmailPhase('idle')
      setPreviewInfo(null)
      setEmailMessage('body changed · re-compose to send')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id, draft.handoff])

  useEffect(() => {
    if (emailPhase !== 'previewing') return
    if (body !== composedBody) {
      setEmailPhase('idle')
      setPreviewInfo(null)
      setEmailMessage('body changed · re-compose to send')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body])
  /* eslint-enable react-hooks/set-state-in-effect */

  async function postHandoff(
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
    try {
      const res = await fetch(`/api/planner/drafts/${draft.id}/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await readJson(res)
      return { ok: res.ok, status: res.status, json }
    } catch (err) {
      return {
        ok: false,
        status: 0,
        json: { error: err instanceof Error ? err.message : 'Network error' },
      }
    }
  }

  /** The server must hold the text on screen before anything leaves the app. */
  async function saved(): Promise<boolean> {
    const ok = await flush()
    if (ok === false) {
      setGeneralError("couldn't save the draft · try again")
      return false
    }
    return true
  }

  // ---- email ----

  async function runCompose(fields: Record<string, unknown>) {
    setEmailMessage(null)
    setGeneralError(null)
    if (!(await saved())) return
    const bodyAtCompose = body
    const r = await postHandoff({ kind: 'email_compose', ...fields })
    if (!r.ok) {
      if (r.status === 403) {
        setEmailDisabled(true)
        setEmailMessage('email is bound to another mailbox')
      } else if (r.status === 503) {
        setEmailDisabled(true)
        setEmailMessage('inbox agent not configured')
      } else {
        setGeneralError((r.json.error as string | undefined) ?? 'Compose failed')
      }
      return
    }
    const draftResp = r.json.draft as PlannerDraftDTO
    const pe = (r.json.result as { pendingEmail: PendingEmail }).pendingEmail
    onDraftChange(draftResp)
    setHandoffRecord(draftResp.handoff)
    setComposedBody(bodyAtCompose)
    const serverPreview = (r.json.result as { preview?: unknown }).preview
    setPreviewInfo({
      to: pe.to,
      cc: pe.cc,
      preview: typeof serverPreview === 'string' ? serverPreview : null,
    })
    setEmailPhase('previewing')
    setShowEmailForm(false)
  }

  async function handleSendEmailClick() {
    if (item.payload.gmailThreadId) {
      await runCompose({ replyAll: false })
    } else {
      setEmailMessage(null)
      setShowEmailForm(true)
    }
  }

  async function handleComposeSubmit() {
    if (!emailTo.trim() || !emailSubject.trim()) return
    await runCompose({ to: emailTo, subject: emailSubject })
  }

  async function handleApproveSend() {
    if (sending) return
    setSending(true)
    try {
      await approveSend()
    } finally {
      setSending(false)
    }
  }

  async function approveSend() {
    setEmailMessage(null)
    const r = await postHandoff({ kind: 'email_send' })
    if (!r.ok) {
      if (r.status === 409) {
        setEmailPhase('idle')
        setPreviewInfo(null)
        setEmailMessage('body changed · re-compose to send')
      } else {
        setGeneralError((r.json.error as string | undefined) ?? 'Send failed')
      }
      return
    }
    const draftResp = r.json.draft as PlannerDraftDTO
    onDraftChange(draftResp)
    setHandoffRecord(draftResp.handoff)
    setEmailPhase('idle')
    setPreviewInfo(null)
  }

  function handleDiscard() {
    setEmailPhase('idle')
    setPreviewInfo(null)
    setEmailMessage(null)
  }

  // ---- gdoc ----

  async function handleGdoc() {
    setGeneralError(null)
    setGdocIssue(null)
    if (!(await saved())) return
    const r = await postHandoff({ kind: 'gdoc' })
    if (!r.ok) {
      const err = r.json.error as string | undefined
      if (err === 'INSUFFICIENT_SCOPES') {
        setGdocIssue({ kind: 'scopes', url: sameOriginPath(r.json.upgradeUrl) })
      } else if (err === 'GOOGLE_NOT_CONNECTED') {
        setGdocIssue({ kind: 'not_connected' })
      } else {
        setGeneralError(err ?? 'Failed to create doc')
      }
      return
    }
    const draftResp = r.json.draft as PlannerDraftDTO
    onDraftChange(draftResp)
    setHandoffRecord(draftResp.handoff)
  }

  // ---- slack ----

  async function runSlackPost(fields: { channel: string; threadTs?: string }) {
    setGeneralError(null)
    if (!(await saved())) return
    const payload: Record<string, unknown> = { kind: 'slack', channel: fields.channel }
    if (fields.threadTs) payload.threadTs = fields.threadTs
    const r = await postHandoff(payload)
    if (!r.ok) {
      const err = r.json.error as string | undefined
      if (err === 'SLACK_NOT_CONNECTED') setSlackNotConnected(true)
      else setGeneralError(err ?? 'Failed to post to Slack')
      return
    }
    const draftResp = r.json.draft as PlannerDraftDTO
    onDraftChange(draftResp)
    setHandoffRecord(draftResp.handoff)
    setShowSlackForm(false)
  }

  async function handleSlackClick() {
    if (item.source === 'slack') {
      const channelId = item.payload.channelId as string
      const threadTs = (item.payload.threadTs ?? item.payload.ts) as string | undefined
      await runSlackPost({ channel: channelId, threadTs })
    } else {
      setSlackNotConnected(false)
      setShowSlackForm(true)
    }
  }

  async function handleSlackFormSubmit() {
    if (!slackChannel.trim()) return
    await runSlackPost({ channel: slackChannel })
  }

  // ---- card comment / create ----

  async function handleCardComment() {
    setGeneralError(null)
    if (!(await saved())) return
    const r = await postHandoff({ kind: 'card_comment', cardId })
    if (!r.ok) {
      setGeneralError((r.json.error as string | undefined) ?? 'Failed to comment')
      return
    }
    const draftResp = r.json.draft as PlannerDraftDTO
    onDraftChange(draftResp)
    setHandoffRecord(draftResp.handoff)
  }

  async function handleCreateCardClick() {
    setShowCardCreateForm(true)
    if (boards.length === 0) {
      try {
        const res = await fetch(`/api/orgs/${orgId}/boards`)
        const json = await readJson(res)
        const list = (json.boards as Board[] | undefined) ?? []
        setBoards(list)
        if (list.length > 0) setSelectedBoardId(list[0].id)
      } catch {
        // leave empty; the select will just show no options
      }
    }
  }

  async function handleCardCreateSubmit() {
    if (!selectedBoardId) return
    setGeneralError(null)
    if (!(await saved())) return
    const r = await postHandoff({ kind: 'card_create', boardId: selectedBoardId })
    if (!r.ok) {
      setGeneralError((r.json.error as string | undefined) ?? 'Failed to create card')
      return
    }
    const draftResp = r.json.draft as PlannerDraftDTO
    onDraftChange(draftResp)
    setHandoffRecord(draftResp.handoff)
    setShowCardCreateForm(false)
  }

  const handoffLink = (() => {
    if (!handoffRecord?.url) return null
    if (handoffRecord.kind === 'gdoc') {
      const href = safeHttpUrl(handoffRecord.url)
      return href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="km-mono"
          style={{ color: 'var(--accent)' }}
        >
          open doc →
        </a>
      ) : null
    }
    if (handoffRecord.kind === 'slack') {
      const href = safeHttpUrl(handoffRecord.url)
      return href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="km-mono"
          style={{ color: 'var(--accent)' }}
        >
          open in slack →
        </a>
      ) : null
    }
    if (handoffRecord.kind === 'card_comment' || handoffRecord.kind === 'card_create') {
      const href = safeItemUrl(handoffRecord.url)
      return href ? (
        <a href={href} className="km-mono" style={{ color: 'var(--accent)' }}>
          open card →
        </a>
      ) : null
    }
    return null
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      <div className="km-eyebrow" style={{ fontSize: 9 }}>
        {'/// handoff'}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          onClick={() => void handleSendEmailClick()}
          disabled={bodyEmpty || emailDisabled}
          className="km-btn km-btn--sm"
        >
          send as email
        </button>
        <button
          type="button"
          onClick={() => void handleGdoc()}
          disabled={bodyEmpty}
          className="km-btn km-btn--sm"
        >
          create google doc
        </button>
        {cardId && (
          <button
            type="button"
            onClick={() => void handleCardComment()}
            disabled={bodyEmpty}
            className="km-btn km-btn--sm"
          >
            comment on card
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleCreateCardClick()}
          disabled={bodyEmpty}
          className="km-btn km-btn--sm"
        >
          create card
        </button>
        <button
          type="button"
          onClick={() => void handleSlackClick()}
          disabled={bodyEmpty}
          className="km-btn km-btn--sm"
        >
          post to slack
        </button>
      </div>

      {showEmailForm && emailPhase === 'idle' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input
            aria-label="To"
            placeholder="to: jane@example.com"
            value={emailTo}
            onChange={(e) => setEmailTo(e.target.value)}
            className="km-input"
            style={{ width: 200 }}
          />
          <input
            aria-label="Subject"
            placeholder="subject"
            value={emailSubject}
            onChange={(e) => setEmailSubject(e.target.value)}
            className="km-input"
            style={{ width: 200 }}
          />
          <button
            type="button"
            onClick={() => void handleComposeSubmit()}
            className="km-btn km-btn--sm"
          >
            compose
          </button>
        </div>
      )}

      {emailPhase === 'previewing' && previewInfo && (
        <div
          data-testid="email-preview"
          style={{ border: '1px solid var(--line)', padding: 10, background: 'var(--bg-2)' }}
        >
          <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>
            to: {previewInfo.to}
          </div>
          <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-2)', marginBottom: 6 }}>
            cc: {previewInfo.cc}
          </div>
          <ReactMarkdown components={plannerMarkdownComponents}>
            {previewInfo.preview ?? body}
          </ReactMarkdown>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              onClick={() => void handleApproveSend()}
              disabled={body !== composedBody || sending}
              className="km-btn km-btn--primary km-btn--sm"
            >
              approve &amp; send
            </button>
            <button
              type="button"
              onClick={handleDiscard}
              className="km-btn km-btn--ghost km-btn--sm"
            >
              discard
            </button>
          </div>
        </div>
      )}

      {emailMessage && (
        <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
          {emailMessage}
        </div>
      )}

      {gdocIssue?.kind === 'scopes' && (
        <a
          href={gdocIssue.url}
          className="km-mono"
          style={{ fontSize: 11, color: 'var(--accent)' }}
        >
          upgrade google connection →
        </a>
      )}
      {gdocIssue?.kind === 'not_connected' && (
        <a
          href="/settings/integrations"
          className="km-mono"
          style={{ fontSize: 11, color: 'var(--accent)' }}
        >
          connect google →
        </a>
      )}

      {showSlackForm && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            aria-label="Slack channel id"
            placeholder="channel id, e.g. C0123ABCD"
            value={slackChannel}
            onChange={(e) => setSlackChannel(e.target.value)}
            className="km-input"
            style={{ width: 160 }}
          />
          <button
            type="button"
            onClick={() => void handleSlackFormSubmit()}
            className="km-btn km-btn--sm"
          >
            post
          </button>
        </div>
      )}
      {slackNotConnected && (
        <a
          href="/settings/integrations"
          className="km-mono"
          style={{ fontSize: 11, color: 'var(--accent)' }}
        >
          connect slack →
        </a>
      )}

      {showCardCreateForm && (
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            aria-label="Board"
            value={selectedBoardId}
            onChange={(e) => setSelectedBoardId(e.target.value)}
            className="km-input"
            style={{ width: 'auto', height: 28, fontSize: 12 }}
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleCardCreateSubmit()}
            className="km-btn km-btn--sm"
          >
            create
          </button>
        </div>
      )}

      {generalError && (
        <div role="alert" className="km-mono" style={{ fontSize: 11, color: 'var(--err)' }}>
          {generalError}
        </div>
      )}

      {handoffRecord && (
        <div
          className="km-mono"
          style={{
            fontSize: 11,
            color: 'var(--fg-3)',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <span>
            handed off · {handoffRecord.kind} · {formatHHMM(handoffRecord.at)}
          </span>
          {handoffLink}
        </div>
      )}
    </div>
  )
}
