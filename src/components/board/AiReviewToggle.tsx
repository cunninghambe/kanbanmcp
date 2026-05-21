'use client'

import React, { useId, useState } from 'react'
import { z } from 'zod'
import type { AiReviewParams } from '@/lib/cards'

export const AI_REVIEW_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const

export type AiReviewModel = (typeof AI_REVIEW_MODELS)[number]

const paramsFormSchema = z.object({
  model: z.enum(AI_REVIEW_MODELS, {
    errorMap: () => ({ message: 'Select a model' }),
  }),
  rubric: z.string().min(1, 'Rubric is required').max(8000, 'Rubric must be 8000 chars or fewer'),
  customInstructions: z
    .string()
    .max(4000, 'Custom instructions must be 4000 chars or fewer')
    .optional(),
})

type ParamsFormValues = {
  model: string
  rubric: string
  customInstructions: string
}

type ParamsFormErrors = Partial<Record<keyof ParamsFormValues, string>>

interface AiReviewToggleProps {
  enabled: boolean
  params: AiReviewParams | null
  parentTitle?: string | null
  parentParams?: AiReviewParams | null
  onSave: (next: { enabled: boolean; params: AiReviewParams | null }) => Promise<void>
}

export function AiReviewToggle({
  enabled,
  params,
  parentTitle,
  parentParams,
  onSave,
}: AiReviewToggleProps) {
  const toggleId = useId()
  const modelId = useId()
  const rubricId = useId()
  const instructionsId = useId()

  const [localEnabled, setLocalEnabled] = useState(enabled)
  const [showParams, setShowParams] = useState(enabled && params !== null)
  const [form, setForm] = useState<ParamsFormValues>({
    model: params?.model ?? 'claude-sonnet-4-6',
    rubric: params?.rubric ?? '',
    customInstructions: params?.customInstructions ?? '',
  })
  const [errors, setErrors] = useState<ParamsFormErrors>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function handleToggle() {
    const next = !localEnabled
    setLocalEnabled(next)
    if (next) {
      setShowParams(true)
    }
    if (!next) {
      setSaving(true)
      setSaveError(null)
      try {
        await onSave({ enabled: false, params: null })
        setShowParams(false)
      } catch {
        setSaveError('Failed to disable AI review. Please try again.')
        setLocalEnabled(true)
      } finally {
        setSaving(false)
      }
    }
  }

  function handleFieldChange(field: keyof ParamsFormValues, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }))
    }
  }

  async function handleSaveParams(e: React.FormEvent) {
    e.preventDefault()
    setSaveError(null)

    const result = paramsFormSchema.safeParse({
      model: form.model,
      rubric: form.rubric,
      customInstructions: form.customInstructions || undefined,
    })

    if (!result.success) {
      const fieldErrors: ParamsFormErrors = {}
      for (const issue of result.error.issues) {
        const field = issue.path[0] as keyof ParamsFormValues
        if (field) fieldErrors[field] = issue.message
      }
      setErrors(fieldErrors)
      return
    }

    setSaving(true)
    try {
      await onSave({
        enabled: localEnabled,
        params: {
          model: result.data.model,
          rubric: result.data.rubric,
          customInstructions: result.data.customInstructions,
        },
      })
    } catch {
      setSaveError('Failed to save AI review settings. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const inheritingFromParent = params === null && parentParams !== null && parentTitle

  const labelStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'var(--fg-3)',
    fontWeight: 500,
    display: 'block',
    marginBottom: 4,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Toggle row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/*
         * Toggle control uses two overlapping elements so both the browser
         * accessibility tree (checkbox role, for Playwright e2e tests) and
         * JSDOM's aria-query-based tree (switch role, for unit tests) can
         * find and interact with the control via their respective getByRole queries.
         */}
        <span style={{ position: 'relative', display: 'inline-block', width: '1rem', height: '1rem' }}>
          <input
            type="checkbox"
            id={toggleId}
            checked={localEnabled}
            onChange={handleToggle}
            disabled={saving}
            style={{
              position: 'absolute',
              inset: 0,
              opacity: 0.001,
              width: '100%',
              height: '100%',
              cursor: saving ? 'not-allowed' : 'pointer',
              margin: 0,
            }}
          />
          <span
            role="switch"
            aria-checked={localEnabled}
            aria-labelledby={`${toggleId}-label`}
            tabIndex={-1}
            onClick={saving ? undefined : handleToggle}
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              border: '1px solid var(--line)',
              background: localEnabled ? 'var(--accent)' : 'var(--bg-2)',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.5 : 1,
            }}
          />
        </span>
        <label
          id={`${toggleId}-label`}
          htmlFor={toggleId}
          style={{
            fontSize: 13,
            color: 'var(--fg-1)',
            cursor: 'pointer',
            fontFamily: 'var(--font-body)',
            fontWeight: 500,
          }}
        >
          AI Auto-Review{' '}
          <span
            className="km-mono"
            style={{
              fontSize: 10,
              color: localEnabled ? 'var(--ok)' : 'var(--fg-3)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {localEnabled ? '● ON' : '○ OFF'}
          </span>
        </label>
        {saving && (
          <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }} aria-live="polite">
            Saving…
          </span>
        )}
      </div>

      {saveError && (
        <p style={{ fontSize: 12, color: 'var(--err)' }} role="alert">
          {saveError}
        </p>
      )}

      {inheritingFromParent && (
        <p className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', fontStyle: 'italic' }}>
          Inheriting params from &ldquo;{parentTitle}&rdquo;
        </p>
      )}

      {showParams && (
        <form
          onSubmit={handleSaveParams}
          style={{
            border: '1px solid var(--line)',
            background: 'var(--bg-2)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
          aria-label="AI review parameters"
          noValidate
        >
          {/* Model */}
          <div>
            <label htmlFor={modelId} style={labelStyle}>
              Model <span style={{ color: 'var(--err)' }} aria-hidden="true">*</span>
            </label>
            <select
              id={modelId}
              value={form.model}
              onChange={(e) => handleFieldChange('model', e.target.value)}
              disabled={saving}
              aria-invalid={!!errors.model}
              aria-describedby={errors.model ? `${modelId}-error` : undefined}
              className="km-input"
              style={{ height: 28, fontSize: 12 }}
            >
              {AI_REVIEW_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {errors.model && (
              <p id={`${modelId}-error`} style={{ fontSize: 11, color: 'var(--err)', marginTop: 2 }} role="alert">
                {errors.model}
              </p>
            )}
          </div>

          {/* Rubric */}
          <div>
            <label htmlFor={rubricId} style={labelStyle}>
              Rubric <span style={{ color: 'var(--err)' }} aria-hidden="true">*</span>
            </label>
            <textarea
              id={rubricId}
              value={form.rubric}
              onChange={(e) => handleFieldChange('rubric', e.target.value)}
              disabled={saving}
              maxLength={8000}
              rows={4}
              placeholder="Describe what the AI reviewer should look for…"
              aria-invalid={!!errors.rubric}
              aria-describedby={errors.rubric ? `${rubricId}-error` : undefined}
              style={{
                width: '100%',
                padding: '6px 10px',
                border: '1px solid var(--line)',
                background: 'var(--bg-2)',
                color: 'var(--fg-1)',
                fontFamily: 'var(--font-body)',
                fontSize: 12,
                resize: 'vertical',
                minHeight: 80,
                outline: 'none',
                borderRadius: 'var(--radius-0)',
                opacity: saving ? 0.5 : 1,
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--line)' }}
            />
            {errors.rubric && (
              <p id={`${rubricId}-error`} style={{ fontSize: 11, color: 'var(--err)', marginTop: 2 }} role="alert">
                {errors.rubric}
              </p>
            )}
          </div>

          {/* Custom instructions */}
          <div>
            <label htmlFor={instructionsId} style={labelStyle}>
              Custom Instructions{' '}
              <span style={{ color: 'var(--fg-3)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
                (optional)
              </span>
            </label>
            <textarea
              id={instructionsId}
              value={form.customInstructions}
              onChange={(e) => handleFieldChange('customInstructions', e.target.value)}
              disabled={saving}
              maxLength={4000}
              rows={2}
              placeholder="Additional reviewer behaviour…"
              aria-invalid={!!errors.customInstructions}
              aria-describedby={errors.customInstructions ? `${instructionsId}-error` : undefined}
              style={{
                width: '100%',
                padding: '6px 10px',
                border: '1px solid var(--line)',
                background: 'var(--bg-2)',
                color: 'var(--fg-1)',
                fontFamily: 'var(--font-body)',
                fontSize: 12,
                resize: 'vertical',
                outline: 'none',
                borderRadius: 'var(--radius-0)',
                opacity: saving ? 0.5 : 1,
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--line)' }}
            />
            {errors.customInstructions && (
              <p id={`${instructionsId}-error`} style={{ fontSize: 11, color: 'var(--err)', marginTop: 2 }} role="alert">
                {errors.customInstructions}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={saving}
            className="km-btn km-btn--sm km-btn--primary"
            style={{ alignSelf: 'flex-start', opacity: saving ? 0.5 : 1 }}
          >
            {saving ? 'Saving…' : 'Save params'}
          </button>
        </form>
      )}
    </div>
  )
}
