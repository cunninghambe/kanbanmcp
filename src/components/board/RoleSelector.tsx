'use client'

import React, { useId } from 'react'

export type OrgMember = {
  id: string
  name: string
  email: string
  isAgent?: boolean
}

export type RoleSelectorLabel = 'Assignee' | 'Reviewer' | 'Approver'

interface RoleSelectorProps {
  label: RoleSelectorLabel
  selectedUserId: string | null
  orgMembers: OrgMember[]
  required?: boolean
  onChange: (userId: string | null) => void
  disabled?: boolean
}

export function RoleSelector({
  label,
  selectedUserId,
  orgMembers,
  required = false,
  onChange,
  disabled = false,
}: RoleSelectorProps) {
  const id = useId()
  const humanMembers = orgMembers.filter((m) => !m.isAgent)
  const agentMembers = orgMembers.filter((m) => m.isAgent)

  const isFormerMember =
    selectedUserId !== null && !orgMembers.some((m) => m.id === selectedUserId)

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value
    onChange(val === '' ? null : val)
  }

  return (
    <div>
      <label
        htmlFor={id}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--fg-3)',
          fontWeight: 500,
          display: 'block',
          marginBottom: 4,
        }}
      >
        {label}
        {required && (
          <span style={{ color: 'var(--err)', marginLeft: 2 }} aria-hidden="true">*</span>
        )}
      </label>
      <select
        id={id}
        className="km-input"
        style={{
          height: 28,
          fontSize: 12,
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
        value={selectedUserId ?? ''}
        onChange={handleChange}
        disabled={disabled}
        aria-required={required}
      >
        {!required && <option value="">Unassigned</option>}
        {required && !selectedUserId && (
          <option value="" disabled>
            Select {label.toLowerCase()}
          </option>
        )}
        {isFormerMember && (
          <option value={selectedUserId!} disabled>
            (former member)
          </option>
        )}

        {humanMembers.length > 0 && (
          <optgroup label="Team Members">
            {humanMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.email})
              </option>
            ))}
          </optgroup>
        )}

        {agentMembers.length > 0 && (
          <optgroup label="Agents">
            {agentMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.email})
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  )
}
