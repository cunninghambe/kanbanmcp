"use client";

import React, { useState } from "react";
import type { SubtreeNode } from "@/lib/tree";

export interface SubcardRowProps {
  node: SubtreeNode;
  hasChildren: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  onToggleExpand: () => void;
  onPromote: () => Promise<void>;
  onOpen: (cardId: string) => void;
  depth: number;
}

const SIGNOFF_DECISION_LABEL: Record<string, string> = {
  APPROVED: "Approved",
  REJECTED: "Rejected",
  REQUESTED_CHANGES: "Changes",
};

const SIGNOFF_DECISION_CLASS: Record<string, string> = {
  APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-600",
  REQUESTED_CHANGES: "bg-yellow-100 text-yellow-700",
};

function SignoffBadge({ role, decision }: { role: string; decision: string }) {
  const label = SIGNOFF_DECISION_LABEL[decision] ?? decision;
  const cls = SIGNOFF_DECISION_CLASS[decision] ?? "bg-slate-100 text-slate-600";
  const prefix = role === "REVIEWER" ? "R" : "A";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}
      title={`${role === "REVIEWER" ? "Reviewer" : "Approver"}: ${label}`}
    >
      {prefix}: {label}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 text-slate-600 text-xs font-bold flex-shrink-0"
      aria-hidden="true"
      title={name}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function SubcardRow({
  node,
  hasChildren,
  isExpanded,
  isLoading,
  onToggleExpand,
  onPromote,
  onOpen,
  depth,
}: SubcardRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const indentStyle = {
    paddingLeft: `${depth * 20}px`,
  } as React.CSSProperties;

  async function handlePromote() {
    const confirmed = window.confirm(
      `Promote "${node.title}" to a top-level card? This will move it out of its parent.`,
    );
    if (!confirmed) return;

    setPromoting(true);
    setPromoteError(null);
    setMenuOpen(false);

    try {
      await onPromote();
    } catch {
      setPromoteError("Promote failed. Please try again.");
    } finally {
      setPromoting(false);
    }
  }

  function handleMenuKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Escape") setMenuOpen(false);
  }

  return (
    <li className="text-sm">
      <div
        className="flex items-center gap-2 py-1 pr-2 rounded hover:bg-slate-50 group"
        style={indentStyle}
      >
        {/* Disclosure chevron — only when the node has children */}
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? `Collapse sub-cards of ${node.title}`
                : `Expand sub-cards of ${node.title}`
            }
            onClick={onToggleExpand}
            disabled={isLoading}
            className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded disabled:opacity-50"
          >
            <svg
              className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
        ) : (
          <span className="flex-shrink-0 w-5" aria-hidden="true" />
        )}

        {/* Card title — opens the sub-card in the panel */}
        <button
          type="button"
          className="flex-1 text-left text-slate-800 font-medium truncate hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
          onClick={() => onOpen(node.id)}
        >
          {node.title}
        </button>

        {/* Assignee avatar */}
        {node.assignee && <Avatar name={node.assignee.name} />}

        {/* Reviewer chip */}
        {node.reviewer && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600 flex-shrink-0"
            title={`Reviewer: ${node.reviewer.name}`}
          >
            R
          </span>
        )}

        {/* Approver chip */}
        {node.approver && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600 flex-shrink-0"
            title={`Approver: ${node.approver.name}`}
          >
            A
          </span>
        )}

        {/* Signoff badges */}
        {node.signoffs.reviewer && (
          <SignoffBadge
            role="REVIEWER"
            decision={node.signoffs.reviewer.decision}
          />
        )}
        {node.signoffs.approver && (
          <SignoffBadge
            role="APPROVER"
            decision={node.signoffs.approver.decision}
          />
        )}

        {/* AI review indicator */}
        {node.aiAutoReview && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700 flex-shrink-0"
            title="AI auto-review enabled"
          >
            AI
          </span>
        )}

        {/* Action menu */}
        <div className="relative flex-shrink-0">
          <button
            type="button"
            aria-label={`Actions for ${node.title}`}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            onKeyDown={handleMenuKeyDown}
            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          >
            <svg
              className="w-4 h-4"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle cx="5" cy="12" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="19" cy="12" r="1.5" />
            </svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-7 z-10 bg-white border border-slate-200 rounded-md shadow-lg py-1 min-w-[180px]"
            >
              <button
                type="button"
                role="menuitem"
                disabled={promoting}
                onClick={() => void handlePromote()}
                className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus:bg-slate-100 focus:outline-none disabled:opacity-50"
              >
                {promoting ? "Promoting…" : "Promote to top-level"}
              </button>
            </div>
          )}
        </div>
      </div>

      {promoteError && (
        <p
          className="text-xs text-red-600 mt-0.5"
          style={indentStyle}
          role="alert"
        >
          {promoteError}
        </p>
      )}
    </li>
  );
}
