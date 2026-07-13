'use client'

import { use } from 'react'
import { ChangeSetReview } from '@/components/changes/ChangeSetReview'

export default function ChangeSetReviewPage({ params }: { params: Promise<{ changeSetId: string }> }) {
  const { changeSetId } = use(params)
  return <ChangeSetReview changeSetId={changeSetId} />
}
