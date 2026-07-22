'use client'

import { Suspense, use } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChangeSetReview } from '@/components/changes/ChangeSetReview'

/**
 * Only an internal, same-origin path is honored as a back-link. Resolving
 * against `window.location.origin` and comparing origins (rather than
 * pattern-matching the raw string) mirrors the browser's own URL
 * normalization — a char-class check misses vectors like a leading
 * backslash or an embedded tab/newline, which the URL parser collapses into
 * a protocol-relative reference (e.g. `/\evil.com` → `//evil.com`) before
 * `router.push` ever sees it. Anything that resolves off-origin, or that
 * fails to parse, falls back to ChangeSetReview's own `/changes` default.
 */
function safeBackHref(raw: string | null): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return undefined
    return url.pathname + url.search + url.hash
  } catch {
    return undefined
  }
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
