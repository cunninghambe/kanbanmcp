// @vitest-environment jsdom
/**
 * Tests for RoleSelector component
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { RoleSelector } from '../../src/components/board/RoleSelector'

const orgMembers = [
  { id: 'user-1', name: 'Alice', email: 'alice@example.com', isAgent: false },
  { id: 'user-2', name: 'Bob', email: 'bob@example.com', isAgent: false },
  { id: 'agent-1', name: 'AI Bot', email: 'bot@example.com', isAgent: true },
]

describe('RoleSelector', () => {
  it('renders a labelled select with member options', () => {
    const onChange = vi.fn()
    render(
      <RoleSelector
        label="Reviewer"
        selectedUserId={null}
        orgMembers={orgMembers}
        onChange={onChange}
      />
    )

    // Has an accessible label
    expect(screen.getByLabelText('Reviewer')).toBeInTheDocument()
    // Has org member options
    expect(screen.getByRole('option', { name: /Alice/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Bob/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /AI Bot/ })).toBeInTheDocument()
  })

  it('shows "Unassigned" option when not required', () => {
    render(
      <RoleSelector
        label="Reviewer"
        selectedUserId={null}
        orgMembers={orgMembers}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByRole('option', { name: 'Unassigned' })).toBeInTheDocument()
  })

  it('does not show empty option when required', () => {
    render(
      <RoleSelector
        label="Assignee"
        selectedUserId="user-1"
        orgMembers={orgMembers}
        required
        onChange={vi.fn()}
      />
    )
    expect(screen.queryByRole('option', { name: 'Unassigned' })).not.toBeInTheDocument()
  })

  it('calls onChange when user selects a member', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <RoleSelector
        label="Reviewer"
        selectedUserId={null}
        orgMembers={orgMembers}
        onChange={onChange}
      />
    )

    const select = screen.getByLabelText('Reviewer')
    await user.selectOptions(select, 'user-1')
    expect(onChange).toHaveBeenCalledWith('user-1')
  })

  it('calls onChange with null when unassigned is selected', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <RoleSelector
        label="Reviewer"
        selectedUserId="user-1"
        orgMembers={orgMembers}
        onChange={onChange}
      />
    )

    const select = screen.getByLabelText('Reviewer')
    await user.selectOptions(select, '')
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('is keyboard accessible — select is focusable', () => {
    render(
      <RoleSelector
        label="Assignee"
        selectedUserId={null}
        orgMembers={orgMembers}
        onChange={vi.fn()}
      />
    )
    const select = screen.getByRole('combobox', { name: /Assignee/ })
    select.focus()
    expect(document.activeElement).toBe(select)
  })

  it('is disabled when disabled prop is set', () => {
    render(
      <RoleSelector
        label="Approver"
        selectedUserId={null}
        orgMembers={orgMembers}
        onChange={vi.fn()}
        disabled
      />
    )
    expect(screen.getByRole('combobox')).toBeDisabled()
  })
})
