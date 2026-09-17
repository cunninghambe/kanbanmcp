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
  const activeDraft = drafts.find((d) => d.id === selectedId) ?? null
  const lastSyncedIdRef = useRef<string | null>(null)

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
  const mountedRef = useRef(true)
  const activeIdRef = useRef<string | null>(null)
  const activeDraftId = activeDraft?.id ?? null
  useEffect(() => {
    activeIdRef.current = activeDraftId
  }, [activeDraftId])

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

  // Sync local editable state from the selected draft. This is the
  // documented "adjust state when a prop changes" effect pattern — the
  // eslint-disable below accepts the extra render it costs in exchange for
  // not duplicating this logic at every place selectedId can change.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!selectedId && drafts.length > 0) {
      setSelectedId(drafts[0].id)
      return
    }
    if (!selectedId || selectedId === lastSyncedIdRef.current) return
    const d = drafts.find((x) => x.id === selectedId)
    if (!d) return
    lastSyncedIdRef.current = selectedId
    setTitle(d.title)
    setBody(d.body)
    dirtyRef.current = {}
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setSaveStatus('idle')
    setPreviousBody(null)
    setGenerateError(null)
    setPreviewOn(false)
  }, [selectedId, drafts])
  /* eslint-enable react-hooks/set-state-in-effect */

  function upsertDraftLocal(updated: PlannerDraftDTO) {
    mutateDrafts((prev) => {
      const list = prev?.drafts ?? []
      const idx = list.findIndex((d) => d.id === updated.id)
      const next = idx === -1 ? [...list, updated] : list.map((d, i) => (i === idx ? updated : d))
      return { drafts: next }
    }, false)
  }

  async function doSave(): Promise<void> {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = dirtyRef.current
    if (!activeDraft || Object.keys(pending).length === 0) return
    dirtyRef.current = {}
    setSaveStatus('saving')
    try {
      const res = await fetch(`/api/planner/drafts/${activeDraft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending),
      })
      const json = await readJson(res)
      if (!mountedRef.current) return
      if (!res.ok) {
        setSaveStatus('error')
        return
      }
      if (json.draft) upsertDraftLocal(json.draft as PlannerDraftDTO)
      setSaveStatus('saved')
      setSavedAt(new Date())
    } catch {
      if (mountedRef.current) setSaveStatus('error')
    }
  }

  function scheduleAutosave(fields: PendingFields) {
    dirtyRef.current = { ...dirtyRef.current, ...fields }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void doSave()
    }, 800)
  }

  async function flush(): Promise<void> {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (Object.keys(dirtyRef.current).length === 0) return
    await doSave()
  }

  function handleBodyChange(v: string) {
    setBody(v)
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
    if (!res.ok || !json.draft) return
    upsertDraftLocal(json.draft as PlannerDraftDTO)
    setSelectedId((json.draft as PlannerDraftDTO).id)
  }

  async function handleGenerate() {
    if (!activeDraft || generating) return
    setGenerateError(null)
    const currentBody = body
    await flush()
    setGenerating(true)
    try {
      const res = await fetch(`/api/planner/drafts/${activeDraft.id}/generate`, {
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
      setPreviousBody((json.previousBody as string | undefined) ?? currentBody)
      setBody(draft.body)
      upsertDraftLocal(draft)
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
            value={selectedId ?? ''}
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
              style={{ fontSize: 10, color: 'var(--fg-3)' }}
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
