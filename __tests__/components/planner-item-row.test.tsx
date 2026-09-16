// @vitest-environment jsdom
/**
 * PlannerItemRow — spec §7.3 "Rows" and §7.4: reasons as toned chips, the
 * four action buttons and their callbacks, reviewer labelling, Reopen on
 * resolved rows, selection styling, and the action-error chip. (WI-5)
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { PlannerItemRow } from '../../src/components/planner/PlannerItemRow'
import type { PlannerItemRowProps } from '../../src/components/planner/PlannerItemRow'
import { rankedItem } from './_helpers/planner-fixtures'
import type { RankedItemDTO } from '../../src/lib/planner/types'

function renderRow(over: Partial<RankedItemDTO> = {}, props: Partial<PlannerItemRowProps> = {}) {
  const onAct = vi.fn()
  const onSelect = vi.fn()
  const item = rankedItem(over)
  const utils = render(
    <ul>
      <PlannerItemRow item={item} selected={false} onSelect={onSelect} onAct={onAct} {...props} />
    </ul>
  )
  const row = screen.getByRole('listitem', { name: item.title })
  return { ...utils, item, row, onAct, onSelect }
}

describe('PlannerItemRow', () => {
  it('labels the row with the title and renders reasons as chips with the spec tones', () => {
    const { row } = renderRow({
      reasons: ['overdue 2d', 'meeting in 40m', 'urgent email', 'assigned to you'],
    })
    expect(within(row).getByText('overdue 2d').className).toMatch(/km-chip--err/)
    expect(within(row).getByText('meeting in 40m').className).toMatch(/km-chip--accent/)
    expect(within(row).getByText('urgent email').className).toMatch(/km-chip--accent/)
    const plain = within(row).getByText('assigned to you')
    expect(plain.className).toMatch(/km-chip/)
    expect(plain.className).not.toMatch(/km-chip--/)
  })

  it("offers done / snooze / dismiss / won't do and reports each through onAct", async () => {
    const user = userEvent.setup()
    const { row, onAct } = renderRow()
    await user.click(within(row).getByRole('button', { name: 'Mark done' }))
    expect(onAct).toHaveBeenLastCalledWith('done')
    await user.click(within(row).getByRole('button', { name: 'Dismiss' }))
    expect(onAct).toHaveBeenLastCalledWith('dismiss')
    await user.click(within(row).getByRole('button', { name: "Won't do" }))
    expect(onAct).toHaveBeenLastCalledWith('wont_do')

    await user.click(within(row).getByRole('button', { name: 'Snooze' }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'later today' }))
    expect(onAct).toHaveBeenLastCalledWith('snooze', {
      snoozedUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('labels the done control "Mark reviewed" for reviewer and approver card rows', () => {
    const reviewer = renderRow({
      id: 'r1',
      title: 'Review the PR',
      payload: { cardId: 'r1', boardId: 'b1', role: 'reviewer' },
    })
    expect(within(reviewer.row).getByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument()
    expect(within(reviewer.row).queryByRole('button', { name: 'Mark done' })).toBeNull()
    reviewer.unmount()

    const approver = renderRow({
      id: 'a1',
      title: 'Approve the spend',
      payload: { cardId: 'a1', boardId: 'b1', role: 'approver' },
    })
    expect(within(approver.row).getByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument()
  })

  it('resolved rows show a single Reopen control', async () => {
    const user = userEvent.setup()
    for (const status of ['done', 'dismissed', 'wont_do'] as const) {
      const { row, onAct, unmount } = renderRow({
        id: `x-${status}`,
        title: `Resolved ${status}`,
        status,
        section: status === 'dismissed' ? 'dismissed' : status,
        resolvedBy: 'user',
        resolvedAt: '2026-09-16T07:00:00.000Z',
      })
      expect(within(row).queryByRole('button', { name: 'Mark done' })).toBeNull()
      expect(within(row).queryByRole('button', { name: 'Snooze' })).toBeNull()
      expect(within(row).queryByRole('button', { name: 'Dismiss' })).toBeNull()
      await user.click(within(row).getByRole('button', { name: 'Reopen' }))
      expect(onAct).toHaveBeenCalledWith('reopen')
      unmount()
    }
  })

  it('clicking the row (not a button) selects it; the selected row is marked', async () => {
    const user = userEvent.setup()
    const { row, onSelect, onAct } = renderRow()
    expect(row).toHaveAttribute('aria-selected', 'false')
    await user.click(within(row).getByText('Ship the release notes'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onAct).not.toHaveBeenCalled()

    const selected = renderRow({ id: 'sel', title: 'Selected row' }, { selected: true })
    expect(selected.row).toHaveAttribute('aria-selected', 'true')
    expect(selected.row.style.borderLeft).toContain('var(--accent)')
  })

  it('renders an action error as an err chip with retry and dismiss', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const onDismissError = vi.fn()
    const { row } = renderRow({}, { error: "couldn't move the card", onRetry, onDismissError })
    const chip = within(row).getByText("couldn't move the card")
    expect(chip.className).toMatch(/km-chip--err/)
    await user.click(within(row).getByRole('button', { name: 'retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    await user.click(within(row).getByRole('button', { name: 'Dismiss error' }))
    expect(onDismissError).toHaveBeenCalledTimes(1)
  })

  it('shows the source and the due/time hint', () => {
    const { row } = renderRow({
      source: 'calendar',
      title: 'Standup',
      startsAt: '2026-09-16T09:00:00.000Z',
      endsAt: '2026-09-16T09:30:00.000Z',
      reasons: ['meeting in 40m'],
    })
    expect(within(row).getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
  })
})
