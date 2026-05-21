'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Header } from '@/components/layout/Header'
import { WebhookManager } from '@/components/settings/WebhookManager'
import { AiBackendManager } from '@/components/settings/AiBackendManager'
import { useSession } from '@/hooks/useSession'
import { Eyebrow } from '@/components/design/Eyebrow'
import { Chip } from '@/components/design/Chip'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface OrgMember {
  userId: string
  orgId: string
  role: 'ADMIN' | 'MEMBER' | 'AGENT_ONLY'
  user: {
    id: string
    name: string
    email: string
  }
}

const ROLE_OPTIONS: Array<'ADMIN' | 'MEMBER' | 'AGENT_ONLY'> = ['ADMIN', 'MEMBER', 'AGENT_ONLY']

function roleChipTone(role: string): 'ok' | 'warn' | 'err' | 'accent' | undefined {
  if (role === 'ADMIN') return 'accent'
  if (role === 'AGENT_ONLY') return 'warn'
  return undefined
}

export default function SettingsPage() {
  const { org, orgMemberships, user } = useSession()
  const currentUserRole = orgMemberships?.[0]?.role ?? 'MEMBER'
  const isAdmin = currentUserRole === 'ADMIN'

  const { data: membersData, mutate: mutateMembers } = useSWR<{ members: OrgMember[] }>(
    org ? `/api/orgs/${org.id}/members` : null,
    fetcher
  )

  const members = membersData?.members ?? []

  const [updatingRole, setUpdatingRole] = useState<string | null>(null)

  async function handleRoleChange(userId: string, newRole: 'ADMIN' | 'MEMBER' | 'AGENT_ONLY') {
    if (!org) return
    setUpdatingRole(userId)
    try {
      await fetch(`/api/orgs/${org.id}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      mutateMembers()
    } finally {
      setUpdatingRole(null)
    }
  }

  return (
    <>
      <Header title="Settings" />
      <main className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-3xl mx-auto space-y-10">
          {/* Org info */}
          <section>
            <h2
              className="text-lg font-semibold mb-4"
              style={{ color: 'var(--fg-0)' }}
            >
              Organization
            </h2>
            <div
              style={{
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                padding: '20px',
              }}
              className="space-y-3"
            >
              <div>
                <Eyebrow size={10}>Name</Eyebrow>
                <p className="mt-1" style={{ color: 'var(--fg-0)' }}>{org?.name ?? '—'}</p>
              </div>
              <div>
                <Eyebrow size={10}>Slug</Eyebrow>
                <p className="km-mono text-sm mt-1" style={{ color: 'var(--fg-0)' }}>
                  {org?.slug ?? '—'}
                </p>
              </div>
            </div>
          </section>

          {/* Members */}
          <section>
            <h2
              className="text-lg font-semibold mb-4"
              style={{ color: 'var(--fg-0)' }}
            >
              Members ({members.length})
            </h2>
            {members.length === 0 ? (
              <div
                className="text-sm text-center py-8"
                style={{
                  color: 'var(--fg-3)',
                  border: '1px dashed var(--line-strong)',
                }}
              >
                No members found
              </div>
            ) : (
              <div style={{ border: '1px solid var(--line)', overflow: 'hidden' }}>
                <table className="w-full text-sm">
                  <thead style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--line)' }}>
                    <tr>
                      <th className="text-left px-4 py-3">
                        <Eyebrow size={10}>Name</Eyebrow>
                      </th>
                      <th className="text-left px-4 py-3">
                        <Eyebrow size={10}>Email</Eyebrow>
                      </th>
                      <th className="text-left px-4 py-3">
                        <Eyebrow size={10}>Role</Eyebrow>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member, i) => {
                      const isCurrentUser = member.user.id === user?.id
                      return (
                        <tr
                          key={member.userId}
                          style={{
                            borderTop: i === 0 ? 'none' : '1px solid var(--line)',
                            background: 'var(--bg-1)',
                          }}
                        >
                          <td className="px-4 py-3 font-medium" style={{ color: 'var(--fg-0)' }}>
                            {member.user.name}
                            {isCurrentUser && (
                              <span className="ml-2 text-xs" style={{ color: 'var(--fg-3)' }}>
                                (you)
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>
                            {member.user.email}
                          </td>
                          <td className="px-4 py-3">
                            {isAdmin && !isCurrentUser ? (
                              <select
                                value={member.role}
                                onChange={(e) =>
                                  handleRoleChange(
                                    member.userId,
                                    e.target.value as 'ADMIN' | 'MEMBER' | 'AGENT_ONLY'
                                  )
                                }
                                disabled={updatingRole === member.userId}
                                className="km-input"
                                style={{ height: 28, fontSize: 12, width: 'auto', padding: '2px 8px' }}
                              >
                                {ROLE_OPTIONS.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <Chip tone={roleChipTone(member.role)}>{member.role}</Chip>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* AI Backend */}
          {org && (
            <section>
              <AiBackendManager orgId={org.id} isAdmin={isAdmin} />
            </section>
          )}

          {/* Webhooks */}
          <section>
            <WebhookManager />
          </section>
        </div>
      </main>
    </>
  )
}
