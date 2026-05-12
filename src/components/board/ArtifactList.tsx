"use client";

import React, { useId, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/Button";
import type { ArtifactResponse, AiReviewSummary } from "@/lib/artifacts";

type ArtifactStatus = AiReviewSummary["status"];

const ALLOWED_ACCEPT =
  "application/pdf,text/*,image/png,image/jpeg,image/webp,application/json,application/x-yaml,text/markdown";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-slate-100 text-slate-600",
  running: "bg-yellow-100 text-yellow-700",
  done: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-600",
  skipped: "bg-slate-100 text-slate-500 line-through",
};

function AiStatusBadge({ review }: { review: AiReviewSummary }) {
  const label = STATUS_LABEL[review.status] ?? review.status;
  const cls = STATUS_CLASS[review.status] ?? "bg-slate-100 text-slate-600";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}
      aria-label={`AI review status: ${label}`}
    >
      {label}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hasActiveReview(artifacts: ArtifactResponse[]): boolean {
  return artifacts.some((a) =>
    a.reviews.some((r) => r.status === "pending" || r.status === "running"),
  );
}

interface ArtifactListProps {
  cardId: string;
  canDelete: (artifact: Pick<ArtifactResponse, "uploader">) => boolean;
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });

export function ArtifactList({ cardId, canDelete }: ArtifactListProps) {
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data, error, isLoading, mutate } = useSWR<{
    artifacts: ArtifactResponse[];
  }>(
    ["artifacts", cardId],
    ([, id]: [string, string]) => fetcher(`/api/cards/${id}/artifacts`),
    {
      refreshInterval: (data) => {
        if (data && hasActiveReview(data.artifacts)) return 5000;
        return 0;
      },
      revalidateOnFocus: true,
    },
  );

  const artifacts = data?.artifacts ?? [];

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`/api/cards/${cardId}/artifacts`, {
        method: "POST",
        body: formData,
      });

      if (res.status === 415) {
        setUploadError(
          "File type not supported. Allowed: PDF, text, images (PNG/JPEG/WebP), JSON, YAML, Markdown.",
        );
        return;
      }
      if (res.status === 413) {
        setUploadError("File too large. Maximum size is 25 MB.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setUploadError(
          (body as { error?: string }).error ??
            "Upload failed. Please try again.",
        );
        return;
      }

      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = "";
      await mutate();
    } catch {
      setUploadError("Upload failed. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(artifactId: string) {
    if (!confirm("Delete this artifact?")) return;
    setDeletingId(artifactId);
    try {
      const res = await fetch(`/api/artifacts/${artifactId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        // silently keep UI in place if delete fails
        console.error("Artifact delete failed:", res.status);
      }
      await mutate();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-3">
      {/* Upload form */}
      <form
        onSubmit={handleUpload}
        className="flex gap-2 items-center flex-wrap"
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
          className="text-sm text-slate-700 file:mr-3 file:py-1 file:px-3 file:rounded-md file:border file:border-slate-300 file:text-sm file:font-medium file:bg-white file:text-slate-700 hover:file:bg-slate-50 file:cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-md disabled:opacity-50"
          aria-label="Choose file to upload"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={uploading}
        >
          {uploading ? "Uploading…" : "Upload artifact"}
        </Button>
      </form>

      {uploadError && (
        <p className="text-xs text-red-600" role="alert" aria-live="assertive">
          {uploadError}
        </p>
      )}

      {/* Artifact list */}
      {isLoading && (
        <div
          className="space-y-2"
          aria-label="Loading artifacts"
          aria-busy="true"
        >
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-10 bg-slate-100 animate-pulse rounded-md"
              aria-hidden="true"
            />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 text-sm text-red-600">
          <span>Could not load artifacts.</span>
          <button
            type="button"
            onClick={() => mutate()}
            className="underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && artifacts.length === 0 && (
        <p className="text-sm text-slate-400 italic">
          No artifacts yet. Upload a file to attach it.
        </p>
      )}

      {!isLoading && !error && artifacts.length > 0 && (
        <ul className="space-y-2" aria-label="Uploaded artifacts">
          {artifacts.map((artifact) => {
            const latestReview = artifact.reviews[0] ?? null;
            const isDeletable = canDelete({ uploader: artifact.uploader });

            return (
              <li
                key={artifact.id}
                className="flex items-start gap-3 p-2 border border-slate-100 rounded-md bg-white text-sm"
              >
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={`/api/artifacts/${artifact.id}/download`}
                      className="font-medium text-blue-600 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded truncate max-w-xs"
                      download={artifact.filename}
                    >
                      {artifact.filename}
                    </a>
                    <span className="text-xs text-slate-400">
                      {formatBytes(artifact.sizeBytes)}
                    </span>
                    {latestReview && (
                      <>
                        <AiStatusBadge review={latestReview} />
                        {latestReview.status === "done" && (
                          <a
                            href={`/api/reviews/${latestReview.id}`}
                            className="text-xs text-blue-600 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
                            target="_blank"
                            rel="noreferrer"
                          >
                            View review
                          </a>
                        )}
                      </>
                    )}
                  </div>
                  <p className="text-xs text-slate-400">
                    Uploaded by {artifact.uploader.name} &middot;{" "}
                    {new Date(artifact.createdAt).toLocaleDateString()}
                  </p>
                </div>

                {isDeletable && (
                  <button
                    type="button"
                    onClick={() => handleDelete(artifact.id)}
                    disabled={deletingId === artifact.id}
                    aria-label={`Delete ${artifact.filename}`}
                    className="text-slate-400 hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-red-500 rounded disabled:opacity-50 flex-shrink-0 transition-colors"
                  >
                    {deletingId === artifact.id ? (
                      <span className="text-xs">Deleting…</span>
                    ) : (
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    )}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
