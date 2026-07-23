'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from '@/hooks/useSession'
import { DesignSidebar } from '@/components/design/Sidebar'
import { NudgeBanner } from '@/components/inbox/NudgeBanner'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace('/login')
    }
  }, [user, isLoading, router])

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg)' }}>
        <div className="km-mono" style={{ fontSize: 12, color: 'var(--fg-3)', letterSpacing: '0.1em' }}>
          loading…
        </div>
      </div>
    )
  }

  if (!user) return null

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--color-bg)' }}>
      <DesignSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <NudgeBanner />
        {children}
      </div>
    </div>
  )
}
