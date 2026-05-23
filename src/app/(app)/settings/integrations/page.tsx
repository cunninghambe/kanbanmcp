'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Header } from '@/components/layout/Header'
import { IntegrationRow } from './IntegrationRow'

export default function IntegrationsPage() {
  const searchParams = useSearchParams()
  const [banner, setBanner] = useState<string | null>(null)
  const bannerDismissed = useRef(false)

  useEffect(() => {
    if (searchParams.get('connected') === '1' && !bannerDismissed.current) {
      setBanner('Google connected successfully.')
    }
  }, [searchParams])

  function dismissBanner() {
    bannerDismissed.current = true
    setBanner(null)
  }

  return (
    <>
      <Header
        breadcrumbs={[
          { label: 'Settings', href: '/settings' },
          { label: 'Integrations' },
        ]}
      />
      <main className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-3xl mx-auto">
          {banner && (
            <div
              role="status"
              style={{
                background: 'var(--ok)',
                color: '#fff',
                padding: '10px 16px',
                fontSize: 13,
                marginBottom: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span>{banner}</span>
              <button
                type="button"
                onClick={dismissBanner}
                aria-label="Dismiss notification"
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#fff',
                  cursor: 'pointer',
                  padding: '0 4px',
                  fontSize: 16,
                  lineHeight: 1,
                }}
              >
                x
              </button>
            </div>
          )}

          <div className="mb-6">
            <p className="text-sm mt-1" style={{ color: 'var(--fg-2)' }}>
              Connect external services to enable AI-powered features.
            </p>
          </div>

          <section aria-label="Connected integrations">
            <h2
              className="text-lg font-semibold mb-4"
              style={{ color: 'var(--fg-0)' }}
            >
              Integrations
            </h2>
            <IntegrationRow integration="google" />
          </section>
        </div>
      </main>
    </>
  )
}
