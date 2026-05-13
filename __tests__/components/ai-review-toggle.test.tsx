// @vitest-environment jsdom
/**
 * Tests for AiReviewToggle component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { AiReviewToggle } from '../../src/components/board/AiReviewToggle'
import type { AiReviewParams } from '../../src/lib/cards'

const defaultParams: AiReviewParams = {
  model: 'claude-sonnet-4-6',
  rubric: 'Check the artifact for quality',
  customInstructions: undefined,
}

describe('AiReviewToggle', () => {
  it('renders a toggle switch with associated label', () => {
    render(<AiReviewToggle enabled={false} params={null} onSave={vi.fn()} />)
    // role="switch" is the ARIA role; testing-library maps it to 'switch'
    const toggle = screen.getByRole('switch')
    expect(toggle).toBeInTheDocument()
    expect(screen.getByText('AI Auto-Review')).toBeInTheDocument()
  })

  it('shows params form when enabled with existing params', () => {
    render(<AiReviewToggle enabled={true} params={defaultParams} onSave={vi.fn()} />)

    expect(screen.getByLabelText(/Rubric/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Model/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Custom Instructions/i)).toBeInTheDocument()
  })

  it('does not show params form when disabled', () => {
    render(<AiReviewToggle enabled={false} params={null} onSave={vi.fn()} />)

    expect(screen.queryByLabelText(/Rubric/i)).not.toBeInTheDocument()
  })

  it('expands params form when toggle is turned on', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)

    render(<AiReviewToggle enabled={false} params={null} onSave={onSave} />)

    const toggle = screen.getByRole('switch')
    await user.click(toggle)

    // Params form should appear (toggle-on does NOT auto-save when params are needed)
    expect(screen.getByLabelText(/Rubric/i)).toBeInTheDocument()
  })

  it('calls onSave with enabled=false when toggle is turned off', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)

    render(<AiReviewToggle enabled={true} params={defaultParams} onSave={onSave} />)

    const toggle = screen.getByRole('switch')
    await user.click(toggle)

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({ enabled: false, params: null })
    })
  })

  it('blocks save when rubric is empty', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()

    render(
      <AiReviewToggle
        enabled={true}
        params={{
          model: 'claude-sonnet-4-6',
          rubric: '',
          customInstructions: undefined,
        }}
        onSave={onSave}
      />
    )

    // The form is shown; clear the rubric and try to save
    const rubric = screen.getByLabelText(/Rubric/i)
    await user.clear(rubric)

    const saveBtn = screen.getByRole('button', { name: /Save params/i })
    await user.click(saveBtn)

    // onSave should NOT be called due to validation
    expect(onSave).not.toHaveBeenCalled()
    // Error message should appear
    expect(screen.getByText(/Rubric is required/i)).toBeInTheDocument()
  })

  it('calls onSave with valid params on submit', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)

    render(<AiReviewToggle enabled={true} params={defaultParams} onSave={onSave} />)

    const saveBtn = screen.getByRole('button', { name: /Save params/i })
    await user.click(saveBtn)

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        enabled: true,
        params: expect.objectContaining({
          rubric: 'Check the artifact for quality',
        }),
      })
    })
  })

  it('shows inheriting hint when params are null and parent has params', () => {
    render(
      <AiReviewToggle
        enabled={true}
        params={null}
        parentTitle="Parent Card"
        parentParams={defaultParams}
        onSave={vi.fn()}
      />
    )
    expect(screen.getByText(/Inheriting params from/i)).toBeInTheDocument()
    expect(screen.getByText(/Parent Card/i)).toBeInTheDocument()
  })
})
