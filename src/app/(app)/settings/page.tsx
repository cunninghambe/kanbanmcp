'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Header } from '@/components/layout/Header'
import { WebhookManager } from '@/components/settings/WebhookManager'
import { useSession } from '@/hooks/useSession'
import { Badge } from '@/components/ui/Badge'

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
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Organization</h2>
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
              <div>
                <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Name</span>
                <p className="text-slate-900 mt-0.5">{org?.name ?? '—'}</p>
              </div>
              <div>
                <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Slug</span>
                <p className="text-slate-900 font-mono text-sm mt-0.5">{org?.slug ?? '—'}</p>
              </div>
            </div>
          </section>

          {/* Members */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Members ({members.length})
            </h2>
            {members.length === 0 ? (
              <div className="text-slate-400 text-sm text-center py-8 border border-dashed border-slate-300 rounded-lg">
                No members found
              </div>
            ) : (
              <div className="overflow-hidden border border-slate-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Name</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Email</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Role</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {members.map((member) => {
                      const isCurrentUser = member.user.id === user?.id
                      return (
                        <tr key={member.userId} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-medium text-slate-800">
                            {member.user.name}
                            {isCurrentUser && (
                              <span className="ml-2 text-xs text-slate-400">(you)</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-500">{member.user.email}</td>
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
                                className="px-2 py-1 border border-slate-300 rounded text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                              >
                                {ROLE_OPTIONS.map((r) => (
                                  <option key={r} value={r}>{r}</option>
                                ))}
                              </select>
                            ) : (
                              <Badge>{member.role}</Badge>
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

          {/* Webhooks */}
          <section>
            <WebhookManager />
          </section>
        </div>
      </main>
    </>
  )
}
