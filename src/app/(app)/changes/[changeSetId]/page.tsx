'use client'

import { Suspense, use } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChangeSetReview } from '@/components/changes/ChangeSetReview'

/**
 * Only an internal, same-origin path is honored as a back-link — anything
 * else (protocol-relative like `//evil.com`, or an absolute URL with a
 * scheme like `https://…`) falls back to ChangeSetReview's own `/changes`
 * default.
 */
function safeBackHref(raw: string | null): string | undefined {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return undefined
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return undefined
  return raw
}

export default function ChangeSetReviewPage({ params }: { params: Promise<{ changeSetId: string }> }) {
  return (
    <Suspense fallback={null}>
      <ChangeSetReviewPageContent params={params} />
    </Suspense>
  )
}

function ChangeSetReviewPageContent({ params }: { params: Promise<{ changeSetId: string }> }) {
  const { changeSetId } = use(params)
  const searchParams = useSearchParams()
  const backHref = safeBackHref(searchParams.get('from'))
  return <ChangeSetReview changeSetId={changeSetId} backHref={backHref} />
}
