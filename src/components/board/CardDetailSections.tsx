'use client'

import { RoleSelector } from './RoleSelector'
import type { OrgMember } from './RoleSelector'
import { AiReviewToggle } from './AiReviewToggle'
import { ArtifactList } from './ArtifactList'
import { SignoffPanel } from './SignoffPanel'
import type { ExistingSignoff } from './SignoffPanel'
import type { AiReviewParams } from '@/lib/cards'
import { SubcardTree } from './SubcardTree'

interface CardDetailSectionsCard {
  id: string
  columnId: string
  assigneeId: string | null
  reviewerId: string | null
  approverId: string | null
  aiAutoReview: boolean
  aiReviewParams: AiReviewParams | null
  parent?: {
    id: string
    title: string
    aiReviewParams: AiReviewParams | null
  } | null
}

interface LatestSignoffs {
  reviewer: ExistingSignoff | null
  approver: ExistingSignoff | null
}

interface CardDetailSectionsProps {
  card: CardDetailSectionsCard
  boardId: string
  orgMembers: OrgMember[]
  currentUserId: string | null
  isReviewer: boolean
  isApprover: boolean
  isOrgAdmin: boolean
  latestSignoffs: LatestSignoffs
  handleRoleChange: (
    field: 'assigneeId' | 'reviewerId' | 'approverId',
    userId: string | null
  ) => Promise<void>
  handleAiReviewSave: (next: { enabled: boolean; params: AiReviewParams | null }) => Promise<void>
  onSignoffSubmitted: () => void
  onOpenCard: (cardId: string) => void
}

function canDeleteArtifact(
  artifact: { uploader: { id: string } },
  currentUserId: string | null,
  isOrgAdmin: boolean
): boolean {
  if (isOrgAdmin) return true
  return artifact.uploader.id === currentUserId
}

export function CardDetailSections({
  card,
  boardId,
  orgMembers,
  currentUserId,
  isReviewer,
  isApprover,
  isOrgAdmin,
  latestSignoffs,
  handleRoleChange,
  handleAiReviewSave,
  onSignoffSubmitted,
  onOpenCard,
}: CardDetailSectionsProps) {
  return (
    <>
      {/* Roles */}
      <section aria-labelledby="roles-heading">
        <h3
          id="roles-heading"
          className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3"
        >
          Roles
        </h3>
        <div className="space-y-3">
          <RoleSelector
            label="Assignee"
            selectedUserId={card.assigneeId}
            orgMembers={orgMembers}
            required
            onChange={(id) => handleRoleChange('assigneeId', id)}
          />
          <RoleSelector
            label="Reviewer"
            selectedUserId={card.reviewerId}
            orgMembers={orgMembers}
            onChange={(id) => handleRoleChange('reviewerId', id)}
          />
          <RoleSelector
            label="Approver"
            selectedUserId={card.approverId}
            orgMembers={orgMembers}
            onChange={(id) => handleRoleChange('approverId', id)}
          />
        </div>
      </section>

      {/* AI Auto-Review */}
      <section aria-labelledby="ai-review-heading">
        <h3
          id="ai-review-heading"
          className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3"
        >
          AI Auto-Review
        </h3>
        <AiReviewToggle
          key={card.id}
          enabled={card.aiAutoReview}
          params={card.aiReviewParams}
          parentTitle={card.parent?.title ?? null}
          parentParams={card.parent?.aiReviewParams ?? null}
          onSave={handleAiReviewSave}
        />
      </section>

      {/* Artifacts */}
      <section aria-labelledby="artifacts-heading">
        <h3
          id="artifacts-heading"
          className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3"
        >
          Artifacts
        </h3>
        <ArtifactList
          cardId={card.id}
          canDelete={(artifact) => canDeleteArtifact(artifact, currentUserId, isOrgAdmin)}
        />
      </section>

      {/* Signoffs */}
      <section aria-labelledby="signoffs-heading">
        <h3
          id="signoffs-heading"
          className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3"
        >
          Signoffs
        </h3>

        {!isReviewer && !isApprover && (
          <div className="space-y-3 text-sm text-slate-500">
            {latestSignoffs.reviewer && (
              <div>
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Reviewer
                </span>
                <div className="mt-1 text-xs text-slate-600">
                  {latestSignoffs.reviewer.user.name} &middot;{' '}
                  {latestSignoffs.reviewer.decision.replace('_', ' ')} &middot;{' '}
                  {new Date(latestSignoffs.reviewer.createdAt).toLocaleString()}
                </div>
              </div>
            )}
            {latestSignoffs.approver && (
              <div>
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Approver
                </span>
                <div className="mt-1 text-xs text-slate-600">
                  {latestSignoffs.approver.user.name} &middot;{' '}
                  {latestSignoffs.approver.decision.replace('_', ' ')} &middot;{' '}
                  {new Date(latestSignoffs.approver.createdAt).toLocaleString()}
                </div>
              </div>
            )}
            {!latestSignoffs.reviewer && !latestSignoffs.approver && (
              <p className="italic text-slate-400">No signoffs yet.</p>
            )}
          </div>
        )}

        {isReviewer && (
          <div className="space-y-3">
            <SignoffPanel
              cardId={card.id}
              role="REVIEWER"
              latestSignoff={latestSignoffs.reviewer}
              onSubmitted={onSignoffSubmitted}
            />
          </div>
        )}

        {isApprover && (
          <div className="space-y-3">
            <SignoffPanel
              cardId={card.id}
              role="APPROVER"
              latestSignoff={latestSignoffs.approver}
              onSubmitted={onSignoffSubmitted}
            />
          </div>
        )}
      </section>

      {/* Sub-cards */}
      <SubcardTree
        cardId={card.id}
        boardId={boardId}
        columnId={card.columnId}
        onOpenCard={onOpenCard}
      />
    </>
  )
}
