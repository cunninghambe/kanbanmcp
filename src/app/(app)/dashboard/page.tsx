'use client'

import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { Plus } from 'lucide-react'
import { Topbar } from '@/components/design/Topbar'
import { StatTile } from '@/components/design/StatTile'
import { QueueTable } from '@/components/design/QueueTable'
import type { QueueRow } from '@/components/design/QueueTable'
import { SprintBurndown } from '@/components/design/Sparkline'
import { Pip } from '@/components/design/Pip'
import { AgentActivityLog } from '@/components/activity/AgentActivityLog'
import { useAssignments } from '@/components/dashboard/AssignmentWidget'
import type { AssignmentCard } from '@/components/dashboard/AssignmentWidget'
import type { AiReviewQueueItem } from '@/app/api/me/ai-review-queue/route'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

function toQueueRow(card: AssignmentCard): QueueRow {
  const now = new Date()
  const overdue = card.dueDate !== null && new Date(card.dueDate) < now
  return {
    id: card.id.slice(-6).toUpperCase(),
    cardId: card.id,
    boardId: card.boardId,
    title: card.title,
    priority: card.priority,
    boardName: card.boardName,
    columnName: card.columnName,
    dueDate: card.dueDate,
    overdue,
  }
}

/** AI review queue side panel */
function AiReviewQueuePanel() {
  const { data, isLoading } = useSWR<{ reviews: AiReviewQueueItem[] }>(
    '/api/me/ai-review-queue',
    fetcher,
    { refreshInterval: 10_000 }
  )

  const reviews = data?.reviews ?? []
  const running = reviews.filter((r) => r.status === 'running').length
  const pending = reviews.filter((r) => r.status === 'pending').length
  const healthy = running === 0 && pending === 0

  return (
    <section style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }} aria-label="AI review queue">
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', background: 'var(--bg-2)' }}>
        <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>{'/// ai-review queue'}</span>
        <span className="km-mono" style={{ fontSize: 10, color: healthy ? 'var(--ok)' : 'var(--accent)' }}>
          ● {healthy ? 'healthy' : `${running} running`}
        </span>
      </div>

      {isLoading ? (
        <div className="km-mono" style={{ padding: '12px 16px', fontSize: 11, color: 'var(--fg-3)' }}>loading…</div>
      ) : reviews.length === 0 ? (
        <div className="km-mono" style={{ padding: '12px 16px', fontSize: 11, color: 'var(--fg-3)' }}>no active reviews</div>
      ) : (
        <div>
          {reviews.map((job, i) => (
            <div
              key={job.id}
              style={{
                padding: '8px 16px',
                borderTop: i === 0 ? 'none' : '1px solid var(--line-faint)',
                display: 'grid',
                gridTemplateColumns: '10px 1fr 70px',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <Pip tone={job.status === 'running' ? 'accent' : 'default'} title={job.status} />
              <div style={{ minWidth: 0 }}>
                <div className="km-mono" style={{ fontSize: 11, color: 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {job.artifactName ?? job.cardTitle}
                </div>
                <div className="km-mono" style={{ fontSize: 9, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
                  {job.id.slice(-8)} · {job.model}
                </div>
              </div>
              <span
                className="km-mono"
                style={{
                  fontSize: 10,
                  color: job.status === 'running' ? 'var(--accent)' : 'var(--fg-3)',
                  textAlign: 'right',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}
              >
                {job.status === 'running' ? '[•••]' : 'pending'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Sprint progress panel — static burndown with placeholder data */
function SprintPanel() {
  const points = [78, 70, 66, 54, 41, 28, 12]
  const total = 78
  const todayIndex = 4
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  const completed = total - points[todayIndex]
  const pct = Math.round((completed / total) * 100)

  return (
    <section style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }} aria-label="Sprint progress">
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', background: 'var(--bg-2)' }}>
        <span className="km-eyebrow" style={{ fontSize: 10, color: 'var(--fg-1)' }}>{'/// sprint'}</span>
        <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>day {todayIndex + 1} / {days.length}</span>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 600, letterSpacing: '-0.025em', color: 'var(--fg-0)', lineHeight: 1 }}>
          {completed}
          <span style={{ color: 'var(--fg-3)', fontSize: 22, marginLeft: 6 }}>/ {total}</span>
        </div>
        <div className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 6, letterSpacing: '0.06em' }}>
          points · {pct}% complete
        </div>
        <div style={{ marginTop: 16 }}>
          <SprintBurndown points={points} total={total} dayLabels={days} todayIndex={todayIndex} />
        </div>
      </div>
    </section>
  )
}

export default function DashboardPage() {
  const router = useRouter()
  const { data, isLoading, error } = useAssignments()

  const now = new Date()
  const asAssignee = data?.asAssignee ?? []
  const asReviewer = data?.asReviewer ?? []
  const asApprover = data?.asApprover ?? []
  const overdue = data?.overdue ?? []

  const overdueCount = overdue.length + asAssignee.filter((c) => c.dueDate && new Date(c.dueDate) < now).length

  const aiReviewCount = useSWR<{ reviews: AiReviewQueueItem[] }>(
    '/api/me/ai-review-queue',
    fetcher,
    { refreshInterval: 10_000 }
  )
  const aiReviews = aiReviewCount.data?.reviews ?? []
  const aiRunning = aiReviews.filter((r) => r.status === 'running').length
  const aiPending = aiReviews.filter((r) => r.status === 'pending').length

  function handleRowClick(row: QueueRow) {
    router.push(`/board/${row.boardId}?card=${row.cardId}`)
  }

  const topbarRight = (
    <div className="flex items-center gap-2">
      <span className="km-mono" style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
        {now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toLowerCase()}
      </span>
      <div style={{ width: 1, height: 20, background: 'var(--line)' }} />
      <button className="km-btn km-btn--sm" aria-label="New card" onClick={() => router.push('/board')}>
        <Plus size={13} /> new card
      </button>
    </div>
  )

  if (isLoading) {
    return (
      <>
        <Topbar breadcrumb="hello" title="your queue" right={topbarRight} />
        <div className="flex-1 flex items-center justify-center km-mono" style={{ color: 'var(--fg-3)', fontSize: 12, letterSpacing: '0.1em' }}>
          loading…
        </div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <Topbar breadcrumb="hello" title="your queue" right={topbarRight} />
        <div role="alert" className="km-mono" style={{ padding: 24, fontSize: 12, color: 'var(--err)' }}>
          failed to load assignments
        </div>
      </>
    )
  }

  return (
    <>
      <Topbar breadcrumb="hello" title="your queue" right={topbarRight} />

      {/* Stats row */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--line)', background: 'var(--bg-1)', flexShrink: 0 }}>
        <StatTile
          label="as assignee"
          value={asAssignee.length}
          sub={asAssignee.filter((c) => c.dueDate !== null).length > 0 ? `${asAssignee.filter((c) => c.dueDate !== null).length} with due dates` : 'none due'}
        />
        <StatTile
          label="as reviewer"
          value={asReviewer.length}
          sub={asReviewer.length > 0 ? 'waiting on you' : 'all clear'}
        />
        <StatTile
          label="as approver"
          value={asApprover.length}
          sub={asApprover.length > 0 ? 'approve to advance' : 'all clear'}
        />
        <StatTile
          label="overdue"
          value={overdueCount}
          sub={overdueCount > 0 ? 'need attention' : 'on track'}
          accent={overdueCount > 0 ? 'err' : 'default'}
        />
        <StatTile
          label="ai-review queue"
          value={aiReviews.length}
          divider={false}
          extra={
            <div style={{ display: 'flex', gap: 12, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Pip tone="accent" /> {aiRunning} running
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Pip /> {aiPending} pending
              </span>
            </div>
          }
        />
      </div>

      {/* Body */}
      <main
        className="flex-1"
        style={{ padding: 20, overflow: 'auto', display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}
      >
        {/* Left: queue tables */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <QueueTable
            label="needs you · reviewer"
            count={asReviewer.length}
            accent="warn"
            rows={asReviewer.map(toQueueRow)}
            onRowClick={handleRowClick}
            emptyLabel="no reviews pending"
          />
          <QueueTable
            label="needs you · approver"
            count={asApprover.length}
            accent="accent"
            rows={asApprover.map(toQueueRow)}
            onRowClick={handleRowClick}
            emptyLabel="no approvals pending"
          />
          <QueueTable
            label="assigned to you"
            count={asAssignee.length + overdue.length}
            rows={[...overdue.map((c) => ({ ...toQueueRow(c), overdue: true })), ...asAssignee.map(toQueueRow)]}
            onRowClick={handleRowClick}
            emptyLabel="no assignments"
          />
        </div>

        {/* Right: sprint + ai review + activity */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SprintPanel />
          <AiReviewQueuePanel />
          <AgentActivityLog />
        </aside>
      </main>
    </>
  )
}
