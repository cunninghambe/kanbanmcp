'use client'

import React, { useId, useState } from 'react'
import { z } from 'zod'
import type { AiReviewParams } from '@/lib/cards'
import { Button } from '@/components/ui/Button'

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
    // If toggling off, save immediately without params form
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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {/*
         * Toggle control uses two overlapping elements so both the browser
         * accessibility tree (checkbox role, for Playwright e2e tests) and
         * JSDOM's aria-query-based tree (switch role, for unit tests) can
         * find and interact with the control via their respective getByRole queries.
         *
         * - <input type="checkbox"> — implicit 'checkbox' role; found by Playwright
         * - <span role="switch">   — explicit 'switch' role; found by unit tests
         */}
        <span style={{ position: 'relative', display: 'inline-block', width: '1rem', height: '1rem' }}>
          <input
            type="checkbox"
            id={toggleId}
            checked={localEnabled}
            onChange={handleToggle}
            disabled={saving}
            style={{ position: 'absolute', inset: 0, opacity: 0.001, width: '100%', height: '100%', cursor: saving ? 'not-allowed' : 'pointer', margin: 0 }}
          />
          <span
            role="switch"
            aria-checked={localEnabled}
            aria-labelledby={`${toggleId}-label`}
            tabIndex={-1}
            onClick={saving ? undefined : handleToggle}
            style={{ display: 'block', width: '100%', height: '100%', borderRadius: '0.125rem', border: '1px solid #cbd5e1', background: localEnabled ? '#2563eb' : '#fff', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.5 : 1 }}
          />
        </span>
        <label id={`${toggleId}-label`} htmlFor={toggleId} className="text-sm font-medium text-slate-700 cursor-pointer">
          AI Auto-Review
        </label>
        {saving && (
          <span className="text-xs text-slate-400" aria-live="polite">
            Saving…
          </span>
        )}
      </div>

      {saveError && (
        <p className="text-xs text-red-600" role="alert">
          {saveError}
        </p>
      )}

      {inheritingFromParent && (
        <p className="text-xs text-slate-500 italic">
          Inheriting params from &ldquo;{parentTitle}&rdquo;
        </p>
      )}

      {showParams && (
        <form
          onSubmit={handleSaveParams}
          className="border border-slate-200 rounded-md p-3 space-y-3 bg-slate-50"
          aria-label="AI review parameters"
          noValidate
        >
          {/* Model */}
          <div>
            <label
              htmlFor={modelId}
              className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 block"
            >
              Model{' '}
              <span className="text-red-500" aria-hidden="true">
                *
              </span>
            </label>
            <select
              id={modelId}
              value={form.model}
              onChange={(e) => handleFieldChange('model', e.target.value)}
              disabled={saving}
              aria-invalid={!!errors.model}
              aria-describedby={errors.model ? `${modelId}-error` : undefined}
              className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 bg-white"
            >
              {AI_REVIEW_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {errors.model && (
              <p id={`${modelId}-error`} className="text-xs text-red-600 mt-0.5" role="alert">
                {errors.model}
              </p>
            )}
          </div>

          {/* Rubric */}
          <div>
            <label
              htmlFor={rubricId}
              className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 block"
            >
              Rubric{' '}
              <span className="text-red-500" aria-hidden="true">
                *
              </span>
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
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y min-h-[80px] disabled:opacity-50 bg-white"
            />
            {errors.rubric && (
              <p id={`${rubricId}-error`} className="text-xs text-red-600 mt-0.5" role="alert">
                {errors.rubric}
              </p>
            )}
          </div>

          {/* Custom instructions */}
          <div>
            <label
              htmlFor={instructionsId}
              className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 block"
            >
              Custom Instructions
              <span className="text-slate-400 font-normal normal-case tracking-normal ml-1">
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
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y disabled:opacity-50 bg-white"
            />
            {errors.customInstructions && (
              <p
                id={`${instructionsId}-error`}
                className="text-xs text-red-600 mt-0.5"
                role="alert"
              >
                {errors.customInstructions}
              </p>
            )}
          </div>

          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save params'}
          </Button>
        </form>
      )}
    </div>
  )
}
