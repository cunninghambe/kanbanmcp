'use client'

import React, { useId, useRef, useState } from 'react'
import useSWR from 'swr'
import { FileText, Image, File, Upload, X } from 'lucide-react'
import { Pip } from '@/components/design/Pip'
import type { ArtifactResponse, AiReviewSummary } from '@/lib/artifacts'

type ArtifactStatus = AiReviewSummary['status']

const ALLOWED_ACCEPT =
  'application/pdf,text/*,image/png,image/jpeg,image/webp,application/json,application/x-yaml,text/markdown'

function mimeIcon(mime: string) {
  if (mime.startsWith('image/')) return <Image size={14} color="var(--fg-3)" />
  if (mime === 'application/pdf' || mime.startsWith('text/')) return <FileText size={14} color="var(--fg-3)" />
  return <File size={14} color="var(--fg-3)" />
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function hasActiveReview(artifacts: ArtifactResponse[]): boolean {
  return artifacts.some((a) =>
    a.reviews.some((r) => r.status === 'pending' || r.status === 'running')
  )
}

const STATUS_DISPLAY: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
}

function ReviewStatusCell({ review }: { review: AiReviewSummary }) {
  const status: ArtifactStatus = review.status
  const displayLabel = STATUS_DISPLAY[status] ?? status

  if (status === 'done') {
    return (
      <span
        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        aria-label={`AI review status: ${displayLabel}`}
      >
        <Pip tone="ok" />
        <span
          className="km-mono"
          style={{
            fontSize: 10,
            color: 'var(--ok)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          ai review · pass
        </span>
        <a
          href={`/api/reviews/${review.id}`}
          target="_blank"
          rel="noreferrer"
          className="km-mono"
          style={{ fontSize: 9, color: 'var(--fg-3)', textDecoration: 'underline' }}
        >
          View review
        </a>
      </span>
    )
  }
  if (status === 'running' || status === 'pending') {
    return (
      <span
        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        aria-label={`AI review status: ${displayLabel}`}
      >
        <Pip tone="accent" />
        <span
          className="km-mono"
          style={{
            fontSize: 10,
            color: 'var(--accent)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          ai review · {status} [•••]
        </span>
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span
        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        aria-label={`AI review status: ${displayLabel}`}
      >
        <Pip tone="err" />
        <span
          className="km-mono"
          style={{
            fontSize: 10,
            color: 'var(--err)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          ai review · failed
        </span>
      </span>
    )
  }
  // skipped / unknown
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
      aria-label={`AI review status: ${displayLabel}`}
    >
      <Pip />
      <span
        className="km-mono"
        style={{
          fontSize: 10,
          color: 'var(--fg-3)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}
      >
        skipped
      </span>
    </span>
  )
}

interface ArtifactListProps {
  cardId: string
  canDelete: (artifact: Pick<ArtifactResponse, 'uploader'>) => boolean
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

export function ArtifactList({ cardId, canDelete }: ArtifactListProps) {
  const fileInputId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const { data, error, isLoading, mutate } = useSWR<{
    artifacts: ArtifactResponse[]
  }>(['artifacts', cardId], ([, id]: [string, string]) => fetcher(`/api/cards/${id}/artifacts`), {
    refreshInterval: (data) => {
      if (data && hasActiveReview(data.artifacts)) return 5000
      return 0
    },
    revalidateOnFocus: true,
  })

  const artifacts = data?.artifacts ?? []

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const file = fileInputRef.current?.files?.[0]
    if (!file) return

    setUploading(true)
    setUploadError(null)

    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch(`/api/cards/${cardId}/artifacts`, {
        method: 'POST',
        body: formData,
      })

      if (res.status === 415) {
        setUploadError('File type not supported. Allowed: PDF, text, images (PNG/JPEG/WebP), JSON, YAML, Markdown.')
        return
      }
      if (res.status === 413) {
        setUploadError('File too large. Maximum size is 25 MB.')
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setUploadError((body as { error?: string }).error ?? 'Upload failed. Please try again.')
        return
      }

      if (fileInputRef.current) fileInputRef.current.value = ''
      await mutate()
    } catch {
      setUploadError('Upload failed. Check your connection and try again.')
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(artifactId: string) {
    if (!confirm('Delete this artifact?')) return
    setDeletingId(artifactId)
    try {
      const res = await fetch(`/api/artifacts/${artifactId}`, { method: 'DELETE' })
      if (!res.ok) {
        console.error('Artifact delete failed:', res.status)
      }
      await mutate()
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div>
      {/* Upload form */}
      <form
        onSubmit={handleUpload}
        style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}
        noValidate
      >
        <label htmlFor={fileInputId} className="sr-only">
          Choose file to upload
        </label>
        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          accept={ALLOWED_ACCEPT}
          disabled={uploading}
          className="km-mono"
          style={{
            fontSize: 11,
            color: 'var(--fg-2)',
            flex: 1,
            minWidth: 0,
          }}
          aria-label="Choose file to upload"
        />
        <button
          type="submit"
          disabled={uploading}
          className="km-btn km-btn--sm"
          style={{ opacity: uploading ? 0.5 : 1, flexShrink: 0 }}
          aria-label="Upload artifact"
        >
          <Upload size={11} />
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      {uploadError && (
        <p style={{ fontSize: 12, color: 'var(--err)', marginBottom: 8 }} role="alert" aria-live="assertive">
          {uploadError}
        </p>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <div style={{ border: '1px solid var(--line)', background: 'var(--bg-2)' }} aria-label="Loading artifacts" aria-busy="true">
          {[1, 2].map((i) => (
            <div
              key={i}
              style={{
                height: 40,
                background: 'var(--bg-3)',
                borderTop: i > 1 ? '1px solid var(--line-faint)' : undefined,
              }}
              aria-hidden="true"
            />
          ))}
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'var(--err)' }}>
          <span>Could not load artifacts.</span>
          <button
            type="button"
            onClick={() => mutate()}
            style={{
              fontSize: 12,
              color: 'var(--accent)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && artifacts.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--fg-3)', fontStyle: 'italic' }}>
          No artifacts yet.
        </p>
      )}

      {!isLoading && !error && artifacts.length > 0 && (
        <ul
          style={{ border: '1px solid var(--line)', background: 'var(--bg-2)', listStyle: 'none', margin: 0, padding: 0 }}
          aria-label="Uploaded artifacts"
        >
          {artifacts.map((artifact, i) => {
            const latestReview = artifact.reviews[0] ?? null
            const isDeletable = canDelete({ uploader: artifact.uploader })

            return (
              <li
                key={artifact.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '20px 1fr 70px 110px 1fr 24px',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px',
                  borderTop: i === 0 ? 0 : '1px solid var(--line-faint)',
                }}
              >
                {/* File type icon */}
                <span aria-hidden="true">{mimeIcon(artifact.mimeType)}</span>

                {/* Filename */}
                <a
                  href={`/api/artifacts/${artifact.id}/download`}
                  download={artifact.filename}
                  className="km-mono"
                  style={{
                    fontSize: 12,
                    color: 'var(--fg-1)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textDecoration: 'none',
                  }}
                  title={artifact.filename}
                >
                  {artifact.filename}
                </a>

                {/* Size */}
                <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
                  {formatBytes(artifact.sizeBytes)}
                </span>

                {/* Uploader + date */}
                <span className="km-mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>
                  {artifact.uploader.name} · {new Date(artifact.createdAt).toLocaleDateString()}
                </span>

                {/* Review status */}
                {latestReview ? (
                  <ReviewStatusCell review={latestReview} />
                ) : (
                  <span />
                )}

                {/* Delete button */}
                {isDeletable ? (
                  <button
                    type="button"
                    onClick={() => handleDelete(artifact.id)}
                    disabled={deletingId === artifact.id}
                    aria-label={`Delete ${artifact.filename}`}
                    style={{
                      color: 'var(--fg-3)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                      opacity: deletingId === artifact.id ? 0.5 : 1,
                      flexShrink: 0,
                    }}
                  >
                    {deletingId === artifact.id ? (
                      <span className="km-mono" style={{ fontSize: 9 }}>…</span>
                    ) : (
                      <X size={13} />
                    )}
                  </button>
                ) : (
                  <span />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
