'use client'

import { Header } from '@/components/layout/Header'
import { AgentActivityLog } from '@/components/activity/AgentActivityLog'

export default function ActivityPage() {
  return (
    <>
      <Header title="Agent Activity" />
      <main className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-6xl mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-slate-900">Agent Activity</h1>
            <p className="text-sm text-slate-500 mt-1">
              All actions performed by agents via the MCP API.
            </p>
          </div>
          <AgentActivityLog />
        </div>
      </main>
    </>
  )
}
