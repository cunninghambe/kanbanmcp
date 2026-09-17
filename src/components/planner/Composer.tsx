'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import ReactMarkdown from 'react-markdown'
import { HandoffBar } from './HandoffBar'
import { plannerMarkdownComponents } from './markdown'
import { DRAFT_MODES } from '@/lib/planner/types'
import type { DraftMode, PlannerDraftDTO, PlannerSource, RankedItemDTO } from '@/lib/planner/types'

// Spec: docs/specs/mhud-today-planner.md §7.3 "Composer" and §7.4.

export interface ComposerProps {
  item: RankedItemDTO
  orgId: string
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

const MODE_LABEL: Record<DraftMode, string> = {
  reply_email: 'reply',
  document: 'document',
  slack_message: 'slack message',
  freeform: 'freeform',
}

function defaultModeFor(source: PlannerSource): DraftMode {
  if (source === 'email') return 'reply_email'
  if (source === 'slack') return 'slack_message'
  return 'document'
}

function defaultDraftTitle(item: RankedItemDTO): string {
  return item.source === 'email' ? `Re: ${item.title}` : item.title
}

function formatHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
type PendingFields = Partial<{ title: string; body: string }>

const EMPTY_DRAFTS: PlannerDraftDTO[] = []

export function Composer({ item, orgId }: ComposerProps) {
  const key = `/api/planner/drafts?itemId=${item.id}`
  const { data, mutate: mutateDrafts } = useSWR<{ drafts: PlannerDraftDTO[] }>(key, fetcher)
  const drafts = data?.drafts ?? EMPTY_DRAFTS

  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The first draft is the default selection; no effect needed to pick it.
  const effectiveSelectedId = selectedId ?? drafts[0]?.id ?? null
  const activeDraft = drafts.find((d) => d.id === effectiveSelectedId) ?? null
  const [syncedId, setSyncedId] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [previewOn, setPreviewOn] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [instructions, setInstructions] = useState('')
  const [mode, setMode] = useState<DraftMode>(() => defaultModeFor(item.source))
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [previousBody, setPreviousBody] = useState<string | null>(null)

  const dirtyRef = useRef<PendingFields>({})
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveInFlightRef = useRef<Promise<boolean> | null>(null)
  const mountedRef = useRef(true)
  const activeIdRef = useRef<string | null>(null)
  const activeDraftId = activeDraft?.id ?? null

  // Unmount: stop the debounce, send any pending edit once (fire-and-forget,
  // no state touched), and make in-flight saves skip their state updates.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const pending = dirtyRef.current
      const id = activeIdRef.current
      dirtyRef.current = {}
      if (id && Object.keys(pending).length > 0) {
        void fetch(`/api/planner/drafts/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pending),
        }).catch(() => {})
      }
    }
  }, [])

  // The editor follows the selected draft. State is adjusted during render
  // (the React "adjust state when a prop changes" pattern) so the textarea
  // never paints a frame with the wrong body; the refs (debounce + pending
  // edit) are handled in the effect below, where refs belong.
  if (activeDraft && activeDraft.id !== syncedId) {
    setSyncedId(activeDraft.id)
    setTitle(activeDraft.title)
    setBody(activeDraft.body)
    setSaveStatus('idle')
    setPreviousBody(null)
    setGenerateError(null)
    setPreviewOn(false)
  }

  // Switching drafts: stop the old debounce and send the old draft's pending
  // edit once (fire-and-forget) so nothing typed is lost.
  useEffect(() => {
    const previousId = activeIdRef.current
    activeIdRef.current = activeDraftId
    if (previousId === activeDraftId) return
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = dirtyRef.current
    dirtyRef.current = {}
    if (previousId && Object.keys(pending).length > 0) {
      void fetch(`/api/planner/drafts/${previousId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending),
      }).catch(() => {})
    }
  }, [activeDraftId])

  function upsertDraftLocal(updated: PlannerDraftDTO) {
    mutateDrafts((prev) => {
      const list = prev?.drafts ?? []
      const idx = list.findIndex((d) => d.id === updated.id)
      const next = idx === -1 ? [...list, updated] : list.map((d, i) => (i === idx ? updated : d))
      return { drafts: next }
    }, false)
  }

  /** Sends the pending fields. Resolves true when the server now has them; a
   *  failed save puts the fields back so the next flush retries. */
  async function doSave(): Promise<boolean> {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = dirtyRef.current
    if (!activeDraft || Object.keys(pending).length === 0) return true
    dirtyRef.current = {}
    setSaveStatus('saving')
    const draftId = activeDraft.id
    let thisRun: Promise<boolean> | null = null
    const run = (async (): Promise<boolean> => {
      try {
        const res = await fetch(`/api/planner/drafts/${draftId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pending),
        })
        const json = await readJson(res)
        if (!res.ok) {
          dirtyRef.current = { ...pending, ...dirtyRef.current }
          if (mountedRef.current) setSaveStatus('error')
          return false
        }
        if (!mountedRef.current) return true
        if (json.draft) upsertDraftLocal(json.draft as PlannerDraftDTO)
        setSaveStatus('saved')
        setSavedAt(new Date())
        return true
      } catch {
        dirtyRef.current = { ...pending, ...dirtyRef.current }
        if (mountedRef.current) setSaveStatus('error')
        return false
      } finally {
        if (saveInFlightRef.current === thisRun) saveInFlightRef.current = null
      }
    })()
    thisRun = run
    saveInFlightRef.current = run
    return run
  }

  function scheduleAutosave(fields: PendingFields) {
    dirtyRef.current = { ...dirtyRef.current, ...fields }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void doSave()
    }, 800)
  }

  /** Cancels the debounce and makes sure the server has the current text:
   *  waits for an in-flight save, then sends whatever is still pending. */
  async function flush(): Promise<boolean> {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (saveInFlightRef.current) {
      const ok = await saveInFlightRef.current
      if (!ok) return false
    }
    if (Object.keys(dirtyRef.current).length === 0) return true
    return doSave()
  }

  function handleBodyChange(v: string) {
    setBody(v)
    setPreviousBody(null)
    scheduleAutosave({ body: v })
  }

  function handleTitleChange(v: string) {
    setTitle(v)
    scheduleAutosave({ title: v })
  }

  async function handleNewDraft() {
    const t = defaultDraftTitle(item)
    const res = await fetch('/api/planner/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id, title: t }),
    })
    const json = await readJson(res)
    if (!res.ok || !json.draft) {
      setGenerateError((json.error as string | undefined) ?? 'Could not create a draft')
      return
    }
    upsertDraftLocal(json.draft as PlannerDraftDTO)
    setSelectedId((json.draft as PlannerDraftDTO).id)
  }

  async function handleGenerate() {
    if (!activeDraft || generating) return
    setGenerateError(null)
    const currentBody = body
    const targetId = activeDraft.id
    if (!(await flush())) {
      setGenerateError("couldn't save your edits · try again")
      return
    }
    setGenerating(true)
    try {
      const res = await fetch(`/api/planner/drafts/${targetId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions, mode, currentBody }),
      })
      const json = await readJson(res)
      if (!res.ok) {
        setGenerateError((json.error as string | undefined) ?? 'Draft generation failed')
        return
      }
      const draft = json.draft as PlannerDraftDTO
      upsertDraftLocal(draft)
      // The user may have switched drafts meanwhile: never write into the wrong editor.
      if (activeIdRef.current !== targetId) return
      setPreviousBody((json.previousBody as string | undefined) ?? currentBody)
      setBody(draft.body)
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setGenerating(false)
    }
  }

  function handleUndo() {
    if (previousBody === null) return
    const restored = previousBody
    setPreviousBody(null)
    setBody(restored)
    scheduleAutosave({ body: restored })
  }

  const saveStatusText =
    saveStatus === 'saving'
      ? 'saving…'
      : saveStatus === 'saved' && savedAt
        ? `saved · ${formatHHMM(savedAt)}`
        : saveStatus === 'error'
          ? 'save failed'
          : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={() => void handleNewDraft()} className="km-btn km-btn--sm">
          new draft
        </button>
        {drafts.length > 0 && (
          <select
            aria-label="Draft"
            value={effectiveSelectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value)}
            className="km-input"
            style={{ width: 'auto', height: 28, fontSize: 12 }}
          >
            {drafts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {activeDraft && (
        <>
          <input
            aria-label="Draft title"
            value={title}
            disabled={generating}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="km-input"
            style={{ fontSize: 13 }}
          />

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              aria-pressed={previewOn}
              onClick={() => setPreviewOn((v) => !v)}
              className="km-btn km-btn--ghost km-btn--sm"
            >
              preview
            </button>
            <span
              data-testid="save-status"
              className="km-mono"
              aria-live="polite"
              style={{ fontSize: 10, color: saveStatus === 'error' ? 'var(--err)' : 'var(--fg-3)' }}
            >
              {saveStatusText}
            </span>
            {previousBody !== null && (
              <button
                type="button"
                onClick={handleUndo}
                className="km-btn km-btn--ghost km-btn--sm"
              >
                undo
              </button>
            )}
          </div>

          {previewOn ? (
            <div
              data-testid="composer-preview"
              style={{
                border: '1px solid var(--line)',
                padding: 12,
                minHeight: 200,
                background: 'var(--bg-1)',
              }}
            >
              <ReactMarkdown components={plannerMarkdownComponents}>{body}</ReactMarkdown>
            </div>
          ) : (
            <textarea
              aria-label="Draft body"
              value={body}
              disabled={generating}
              onChange={(e) => handleBodyChange(e.target.value)}
              rows={14}
              className="km-input km-mono"
              style={{ resize: 'vertical', lineHeight: 1.5, fontSize: 12 }}
            />
          )}

          <div className="km-eyebrow" style={{ fontSize: 9, marginTop: 4 }}>
            {'/// ask claude'}
          </div>
          <textarea
            aria-label="Instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                void handleGenerate()
              }
            }}
            rows={2}
            className="km-input"
            style={{ fontSize: 12 }}
            placeholder="what should claude do with this draft…"
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              aria-label="Mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as DraftMode)}
              className="km-input"
              style={{ width: 'auto', height: 28, fontSize: 12 }}
            >
              {DRAFT_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={generating}
              className="km-btn km-btn--sm"
            >
              {generating ? 'generating…' : 'ask claude'}
            </button>
          </div>
          {generateError && (
            <div role="alert" className="km-mono" style={{ fontSize: 11, color: 'var(--err)' }}>
              {generateError}
            </div>
          )}

          <HandoffBar
            item={item}
            draft={activeDraft}
            body={body}
            orgId={orgId}
            flush={flush}
            onDraftChange={upsertDraftLocal}
          />
        </>
      )}
    </div>
  )
}
