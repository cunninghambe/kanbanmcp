'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface AgentActivity {
  id: string
  agentName: string
  action: string
  resourceType: string
  resourceId: string
  metadata: Record<string, unknown> | string
  createdAt: string
}

interface ActivityResponse {
  activities: AgentActivity[]
  total: number
  page: number
  limit: number
}

export function AgentActivityLog() {
  const [agentFilter, setAgentFilter] = useState('')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const query = new URLSearchParams({ page: String(page), limit: '20' })
  if (agentFilter.trim()) query.set('agentName', agentFilter.trim())

  const { data, isLoading } = useSWR<ActivityResponse>(
    `/api/activity?${query.toString()}`,
    fetcher,
    { refreshInterval: 10000 }
  )

  const activities = data?.activities ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / 20)

  function handleFilterChange(val: string) {
    setAgentFilter(val)
    setPage(1)
  }

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={agentFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
          placeholder="Filter by agent name…"
          className="px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
        />
        {agentFilter && (
          <Button size="sm" variant="ghost" onClick={() => handleFilterChange('')}>
            Clear
          </Button>
        )}
        <span className="text-sm text-slate-500 ml-auto">
          {total} {total === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-center py-10 text-slate-400 text-sm">Loading activity…</div>
      ) : activities.length === 0 ? (
        <div className="text-center py-10 text-slate-400 text-sm border border-dashed border-slate-300 rounded-lg">
          {agentFilter ? `No activity from agent "${agentFilter}"` : 'No agent activity yet'}
        </div>
      ) : (
        <div className="overflow-hidden border border-slate-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Agent</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Action</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Resource</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Resource ID</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Metadata</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activities.map((activity) => {
                const metadataStr =
                  typeof activity.metadata === 'object'
                    ? JSON.stringify(activity.metadata)
                    : String(activity.metadata ?? '')
                const isExpanded = expandedId === activity.id
                const isLong = metadataStr.length > 60

                return (
                  <tr key={activity.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Badge>{activity.agentName}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">
                      {activity.action}
                    </td>
                    <td className="px-4 py-3 text-slate-500">{activity.resourceType}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500 max-w-[120px] truncate">
                      {activity.resourceId}
                    </td>
                    <td className="px-4 py-3 max-w-[200px]">
                      {isLong ? (
                        <div>
                          <code className="text-xs text-slate-600 font-mono">
                            {isExpanded ? metadataStr : `${metadataStr.slice(0, 60)}…`}
                          </code>
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : activity.id)}
                            className="block text-xs text-blue-600 hover:underline mt-0.5"
                          >
                            {isExpanded ? 'collapse' : 'expand'}
                          </button>
                        </div>
                      ) : (
                        <code className="text-xs text-slate-600 font-mono">{metadataStr}</code>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap text-xs">
                      {new Date(activity.createdAt).toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <span className="text-sm text-slate-500">
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
