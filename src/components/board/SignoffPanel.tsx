"use client";

import React, { useId, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/Button";

export type SignoffRole = "REVIEWER" | "APPROVER";
export type SignoffDecision = "APPROVED" | "REJECTED" | "REQUESTED_CHANGES";

export type ExistingSignoff = {
  id: string;
  role: SignoffRole;
  decision: SignoffDecision;
  comment: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
};

const submitSchema = z.object({
  comment: z
    .string()
    .max(2000, "Comment must be 2000 chars or fewer")
    .optional(),
});

const DECISION_CONFIG: Record<
  SignoffDecision,
  { label: string; ariaLabel: string; className: string }
> = {
  APPROVED: {
    label: "Approve",
    ariaLabel: "Approve this card",
    className:
      "bg-green-600 text-white hover:bg-green-700 focus:ring-green-500 focus:ring-2 focus:ring-offset-2",
  },
  REQUESTED_CHANGES: {
    label: "Request changes",
    ariaLabel: "Request changes to this card",
    className:
      "bg-yellow-500 text-white hover:bg-yellow-600 focus:ring-yellow-500 focus:ring-2 focus:ring-offset-2",
  },
  REJECTED: {
    label: "Reject",
    ariaLabel: "Reject this card",
    className:
      "bg-red-600 text-white hover:bg-red-700 focus:ring-red-500 focus:ring-2 focus:ring-offset-2",
  },
};

const DECISION_BADGE: Record<SignoffDecision, string> = {
  APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-600",
  REQUESTED_CHANGES: "bg-yellow-100 text-yellow-700",
};

const DECISION_LABEL: Record<SignoffDecision, string> = {
  APPROVED: "Approved",
  REJECTED: "Rejected",
  REQUESTED_CHANGES: "Changes requested",
};

interface SignoffPanelProps {
  cardId: string;
  role: SignoffRole;
  latestSignoff?: ExistingSignoff | null;
  onSubmitted: () => void;
}

export function SignoffPanel({
  cardId,
  role,
  latestSignoff,
  onSubmitted,
}: SignoffPanelProps) {
  const commentId = useId();
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const roleLabel = role === "REVIEWER" ? "Reviewer" : "Approver";

  async function handleDecision(decision: SignoffDecision) {
    setSubmitError(null);
    setCommentError(null);
    setSuccessMessage(null);

    const validation = submitSchema.safeParse({
      comment: comment || undefined,
    });
    if (!validation.success) {
      setCommentError(validation.error.issues[0]?.message ?? "Invalid comment");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/cards/${cardId}/signoffs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          decision,
          comment: comment.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSubmitError(
          (body as { error?: string }).error ??
            "Submission failed. Please try again.",
        );
        return;
      }

      setComment("");
      setSuccessMessage(`${DECISION_LABEL[decision]} successfully recorded.`);
      onSubmitted();
    } catch {
      setSubmitError("Submission failed. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="border border-slate-200 rounded-md p-3 space-y-3 bg-slate-50">
      {/* Latest signoff for this role */}
      {latestSignoff && (
        <div className="text-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
            Latest {roleLabel} decision
          </span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${DECISION_BADGE[latestSignoff.decision]}`}
            >
              {DECISION_LABEL[latestSignoff.decision]}
            </span>
            <span className="text-xs text-slate-500">
              by {latestSignoff.user.name} &middot;{" "}
              {new Date(latestSignoff.createdAt).toLocaleString()}
            </span>
          </div>
          {latestSignoff.comment && (
            <p className="mt-1 text-xs text-slate-600 bg-white border border-slate-100 rounded px-2 py-1">
              {latestSignoff.comment}
            </p>
          )}
        </div>
      )}

      {/* Submit new signoff */}
      <fieldset disabled={submitting} className="space-y-2">
        <legend className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
          Record {roleLabel} decision
        </legend>

        <div>
          <label
            htmlFor={commentId}
            className="text-xs text-slate-500 mb-1 block"
          >
            Comment <span className="text-slate-400">(optional)</span>
          </label>
          <textarea
            id={commentId}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              if (commentError) setCommentError(null);
            }}
            maxLength={2000}
            rows={2}
            placeholder="Add a comment…"
            aria-invalid={!!commentError}
            aria-describedby={commentError ? `${commentId}-error` : undefined}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none bg-white disabled:opacity-50"
          />
          {commentError && (
            <p
              id={`${commentId}-error`}
              className="text-xs text-red-600 mt-0.5"
              role="alert"
            >
              {commentError}
            </p>
          )}
        </div>

        <div className="flex gap-2 flex-wrap">
          {(["APPROVED", "REQUESTED_CHANGES", "REJECTED"] as const).map(
            (decision) => {
              const cfg = DECISION_CONFIG[decision];
              return (
                <button
                  key={decision}
                  type="button"
                  onClick={() => handleDecision(decision)}
                  disabled={submitting}
                  aria-label={cfg.ariaLabel}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${cfg.className}`}
                >
                  {submitting ? "Submitting…" : cfg.label}
                </button>
              );
            },
          )}
        </div>
      </fieldset>

      {submitError && (
        <p className="text-xs text-red-600" role="alert" aria-live="assertive">
          {submitError}
        </p>
      )}

      {successMessage && (
        <p className="text-xs text-green-600" role="status" aria-live="polite">
          {successMessage}
        </p>
      )}
    </div>
  );
}
