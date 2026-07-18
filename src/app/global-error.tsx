'use client'

// Root error boundary — catches errors that escape the root layout itself.
// Next.js renders this in place of the whole document, so it must define its
// own <html>/<body>. https://nextjs.org/docs/app/api-reference/file-conventions/error#global-errorjs
import { useEffect } from 'react'
import { captureException } from '@/lib/uh-oh-client'
import './globals.css'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    captureException(error, { mechanism: 'js-global' })
  }, [error])

  return (
    <html lang="en">
      <body>
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ background: 'var(--color-bg, #F1ECE0)' }}
        >
          <div className="text-center" style={{ padding: '2rem', maxWidth: 420 }}>
            <h1
              style={{
                fontSize: '1.25rem',
                fontWeight: 600,
                color: 'var(--color-text-strong, #0A0A0A)',
                marginBottom: '0.5rem',
              }}
            >
              Something went wrong
            </h1>
            <p style={{ color: 'var(--color-text-muted, #5A574E)', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
              An unexpected error occurred. It has been reported.
            </p>
            <button
              onClick={() => reset()}
              style={{
                padding: '0.5rem 1.25rem',
                background: 'var(--accent, #E11D2B)',
                color: 'var(--fg-inverse, #FFFFFF)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.875rem',
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
