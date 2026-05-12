"use client";

import React, { useState, useEffect, useRef } from "react";
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

// ---- PromoteConfirmDialog ---------------------------------------------------

interface PromoteConfirmDialogProps {
  cardTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function PromoteConfirmDialog({
  cardTitle,
  onConfirm,
  onCancel,
}: PromoteConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus cancel button on mount
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
        aria-hidden="true"
      />
      <dialog
        open
        aria-modal="true"
        aria-labelledby="promote-dialog-title"
        className="relative bg-white rounded-lg shadow-xl w-full max-w-sm p-6 m-0"
      >
        <h2
          id="promote-dialog-title"
          className="text-base font-semibold text-slate-900 mb-2"
        >
          Promote to top-level card?
        </h2>
        <p className="text-sm text-slate-600 mb-5">
          &ldquo;{cardTitle}&rdquo; will be moved out of its parent and become a
          top-level card.
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm font-medium text-slate-600 border border-slate-300 bg-white rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-500 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
          >
            Promote
          </button>
        </div>
      </dialog>
    </div>
  );
}

// ---- SubcardRow -------------------------------------------------------------

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
  const [showPromoteDialog, setShowPromoteDialog] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  const childrenListId = `children-${node.id}`;

  const indentStyle = {
    paddingLeft: `${depth * 20}px`,
  } as React.CSSProperties;

  // Click-outside-to-close for action menu
  useEffect(() => {
    if (!menuOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        menuContainerRef.current &&
        !menuContainerRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [menuOpen]);

  async function handlePromoteConfirmed() {
    setShowPromoteDialog(false);
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
    <>
      {showPromoteDialog && (
        <PromoteConfirmDialog
          cardTitle={node.title}
          onConfirm={() => void handlePromoteConfirmed()}
          onCancel={() => setShowPromoteDialog(false)}
        />
      )}
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
              aria-controls={childrenListId}
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
          <div ref={menuContainerRef} className="relative flex-shrink-0">
            <button
              type="button"
              aria-label={`Actions for ${node.title}`}
              aria-haspopup="menu"
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
                  onClick={() => {
                    setMenuOpen(false);
                    setShowPromoteDialog(true);
                  }}
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
    </>
  );
}
