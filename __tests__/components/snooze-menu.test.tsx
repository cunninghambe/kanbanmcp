// @vitest-environment jsdom
/**
 * SnoozeMenu — spec §7.3 / §7.4: the three preset options and the custom
 * picker produce the expected instants; Escape closes. Expectations are
 * built with local-time constructors so the test is zone-independent. (WI-5)
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { SnoozeMenu, snoozeOptions } from '../../src/components/planner/SnoozeMenu'

const WED = new Date(2026, 8, 16, 14, 30, 0, 0) // Wednesday 16 Sep 2026, 14:30 local

describe('snoozeOptions', () => {
  it('later today is +3h, tomorrow and next monday are 09:00 local', () => {
    const [later, tomorrow, monday] = snoozeOptions(WED)
    expect(later.key).toBe('later_today')
    expect(later.at.getTime()).toBe(WED.getTime() + 3 * 3600_000)
    expect(tomorrow.key).toBe('tomorrow')
    expect(tomorrow.at).toEqual(new Date(2026, 8, 17, 9, 0, 0, 0))
    expect(monday.key).toBe('next_monday')
    expect(monday.at).toEqual(new Date(2026, 8, 21, 9, 0, 0, 0))
  })

  it('from a Monday the next monday is a week out; from a Sunday it is tomorrow', () => {
    expect(snoozeOptions(new Date(2026, 8, 14, 10))[2].at).toEqual(
      new Date(2026, 8, 21, 9, 0, 0, 0)
    )
    expect(snoozeOptions(new Date(2026, 8, 20, 10))[2].at).toEqual(
      new Date(2026, 8, 21, 9, 0, 0, 0)
    )
  })

  it('labels match the menu', () => {
    expect(snoozeOptions(WED).map((o) => o.label)).toEqual([
      'later today',
      'tomorrow 9:00',
      'next monday 9:00',
    ])
  })
})

describe('SnoozeMenu', () => {
  it('renders a menu with the four choices and picks presets as ISO strings', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<SnoozeMenu onPick={onPick} onClose={onClose} now={() => WED} />)
    const menu = screen.getByRole('menu', { name: 'Snooze until' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.textContent)
    ).toEqual(['later today', 'tomorrow 9:00', 'next monday 9:00', 'custom…'])
    await user.click(within(menu).getByRole('menuitem', { name: 'tomorrow 9:00' }))
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 8, 17, 9, 0, 0, 0).toISOString())
  })

  it('custom reveals a datetime-local input and picks its value', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<SnoozeMenu onPick={onPick} onClose={vi.fn()} now={() => WED} />)
    await user.click(screen.getByRole('menuitem', { name: 'custom…' }))
    const input = screen.getByLabelText('Snooze until', { selector: 'input' })
    expect(input).toHaveAttribute('type', 'datetime-local')
    fireEvent.change(input, { target: { value: '2026-09-18T10:00' } })
    await user.click(screen.getByRole('button', { name: 'snooze' }))
    expect(onPick).toHaveBeenCalledWith(new Date('2026-09-18T10:00').toISOString())
  })

  it('custom without a value does not pick; Escape closes', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<SnoozeMenu onPick={onPick} onClose={onClose} now={() => WED} />)
    await user.click(screen.getByRole('menuitem', { name: 'custom…' }))
    await user.click(screen.getByRole('button', { name: 'snooze' }))
    expect(onPick).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})
