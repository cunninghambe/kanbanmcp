'use client'

import { Header } from '@/components/layout/Header'
import { ApiKeyManager } from '@/components/settings/ApiKeyManager'

export default function ApiKeysPage() {
  return (
    <>
      <Header
        breadcrumbs={[
          { label: 'Settings', href: '/settings' },
          { label: 'API Keys' },
        ]}
      />
      <main className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6">
            <p className="text-sm text-slate-500 mt-1">
              API keys allow agents and external services to authenticate with the KanbanMCP API.
              Keys are scoped to your organization.
            </p>
          </div>
          <ApiKeyManager />
        </div>
      </main>
    </>
  )
}
