"use client";

import React, { useState, useCallback } from "react";
import { z } from "zod";
import { useSubcardTree } from "./useSubcardTree";
import { SubcardRow } from "./SubcardRow";
import type { SubtreeNode } from "@/lib/tree";

// Relative depth at which nodes start collapsed
const COLLAPSE_FROM_DEPTH = 3;

// ---- Zod schema for lazy-fetch subtree response -----------------------------

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});

const signoffSummarySchema = z.object({
  id: z.string(),
  decision: z.string(),
  createdAt: z.coerce.date(),
  user: userSchema,
});

const subtreeNodeSchema: z.ZodType<SubtreeNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    parentCardId: z.string().nullable(),
    path: z.string(),
    depth: z.number(),
    aiAutoReview: z.boolean(),
    assigneeId: z.string().nullable(),
    reviewerId: z.string().nullable(),
    approverId: z.string().nullable(),
    assignee: userSchema.nullable(),
    reviewer: userSchema.nullable(),
    approver: userSchema.nullable(),
    aiReviewParams: z
      .object({
        model: z.string(),
        rubric: z.string(),
        customInstructions: z.string().optional(),
      })
      .nullable(),
    signoffs: z.object({
      reviewer: signoffSummarySchema.nullable(),
      approver: signoffSummarySchema.nullable(),
    }),
  }),
);

const subtreeResponseSchema = z.object({
  root: subtreeNodeSchema,
  descendants: z.array(subtreeNodeSchema),
});

// Max siblings to show before a "Show N more" expander
const SIBLINGS_PAGE_SIZE = 50;

export interface SubcardTreeProps {
  cardId: string;
  boardId: string;
  columnId: string;
  onOpenCard: (cardId: string) => void;
}

// Build parentId -> children map from a flat list
function buildChildMap(
  nodes: SubtreeNode[],
  rootId: string,
): Map<string, SubtreeNode[]> {
  const map = new Map<string, SubtreeNode[]>();
  for (const node of nodes) {
    const pid = node.parentCardId ?? rootId;
    const list = map.get(pid) ?? [];
    list.push(node);
    map.set(pid, list);
  }
  return map;
}

// ---- TreeList ---------------------------------------------------------------

interface TreeListProps {
  parentId: string;
  childMap: Map<string, SubtreeNode[]>;
  rootDepth: number;
  isNodeExpanded: (id: string, relDepth: number) => boolean;
  loadingIds: Set<string>;
  onToggleExpand: (node: SubtreeNode, relDepth: number) => void;
  onPromote: (node: SubtreeNode) => Promise<void>;
  onOpenCard: (cardId: string) => void;
  shownCountMap: Map<string, number>;
  onShowMore: (parentId: string, currentCount: number) => void;
}

function TreeList({
  parentId,
  childMap,
  rootDepth,
  isNodeExpanded,
  loadingIds,
  onToggleExpand,
  onPromote,
  onOpenCard,
  shownCountMap,
  onShowMore,
}: TreeListProps) {
  const allChildren = childMap.get(parentId) ?? [];
  const shownCount = shownCountMap.get(parentId) ?? SIBLINGS_PAGE_SIZE;
  const visible = allChildren.slice(0, shownCount);
  const hiddenCount = allChildren.length - visible.length;

  if (allChildren.length === 0) return null;

  return (
    <ul id={`children-${parentId}`} className="list-none m-0 p-0" aria-label="Sub-cards">
      {visible.map((node) => {
        const relDepth = node.depth - rootDepth;
        const expanded = isNodeExpanded(node.id, relDepth);
        const loading = loadingIds.has(node.id);
        const hasChildren = (childMap.get(node.id) ?? []).length > 0;

        return (
          <React.Fragment key={node.id}>
            <SubcardRow
              node={node}
              hasChildren={hasChildren}
              isExpanded={expanded}
              isLoading={loading}
              onToggleExpand={() => onToggleExpand(node, relDepth)}
              onPromote={() => onPromote(node)}
              onOpen={onOpenCard}
              depth={relDepth}
            />
            {expanded && hasChildren && (
              <TreeList
                parentId={node.id}
                childMap={childMap}
                rootDepth={rootDepth}
                isNodeExpanded={isNodeExpanded}
                loadingIds={loadingIds}
                onToggleExpand={onToggleExpand}
                onPromote={onPromote}
                onOpenCard={onOpenCard}
                shownCountMap={shownCountMap}
                onShowMore={onShowMore}
              />
            )}
          </React.Fragment>
        );
      })}
      {hiddenCount > 0 && (
        <li>
          <button
            type="button"
            className="ml-5 mt-1 text-xs text-blue-600 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
            onClick={() => onShowMore(parentId, shownCount)}
          >
            Show {hiddenCount} more
          </button>
        </li>
      )}
    </ul>
  );
}

// ---- AddSubcardForm ---------------------------------------------------------

interface AddSubcardFormProps {
  boardId: string;
  parentCardId: string;
  columnId: string;
  assigneeId: string;
  onCreated: () => void;
  onCancel: () => void;
}

function AddSubcardForm({
  boardId,
  parentCardId,
  columnId,
  assigneeId,
  onCreated,
  onCancel,
}: AddSubcardFormProps) {
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    setSubmitting(true);
    setFormError(null);

    try {
      const res = await fetch(`/api/boards/${boardId}/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmed,
          columnId,
          assigneeId,
          parentCardId,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setFormError(body.error ?? "Failed to create sub-card.");
        return;
      }

      setTitle("");
      onCreated();
    } catch {
      setFormError("Failed to create sub-card. Check your connection.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-center gap-2 mt-2 mb-3"
      aria-label="Add sub-card"
    >
      <label htmlFor="new-subcard-title" className="sr-only">
        Sub-card title
      </label>
      <input
        id="new-subcard-title"
        type="text"
        className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        placeholder="Sub-card title…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={submitting}
        autoFocus
      />
      <button
        type="submit"
        disabled={submitting || !title.trim()}
        className="px-2.5 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={submitting}
        className="px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 bg-white rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-500 disabled:opacity-50 transition-colors"
      >
        Cancel
      </button>
      {formError && (
        <p className="w-full text-xs text-red-600 mt-0.5" role="alert">
          {formError}
        </p>
      )}
    </form>
  );
}

// ---- SubcardTree (main) -----------------------------------------------------

export function SubcardTree({
  cardId,
  boardId,
  columnId,
  onOpenCard,
}: SubcardTreeProps) {
  const { data, isLoading, error, refresh } = useSubcardTree(cardId, 3);

  // Nodes explicitly expanded by the user
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());
  // Nodes explicitly collapsed by the user (overrides default expand for shallow nodes)
  const [manualCollapsed, setManualCollapsed] = useState<Set<string>>(
    new Set(),
  );
  // Nodes whose sub-fetch is in progress
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  // Flat merged tree: base descendants + lazy-fetched descendants keyed by their root
  const [extraDescendants, setExtraDescendants] = useState<SubtreeNode[]>([]);

  const [shownCountMap, setShownCountMap] = useState<Map<string, number>>(
    new Map(),
  );
  const [showAddForm, setShowAddForm] = useState(false);

  const root = data?.root ?? null;
  const descendants = data?.descendants ?? [];
  const rootDepth = root?.depth ?? 0;

  // Merged flat list: initial descendants + lazily loaded ones
  const allDescendants = [...descendants, ...extraDescendants];
  const childMap = buildChildMap(allDescendants, cardId);

  // Determine if a node should be expanded
  function isNodeExpanded(id: string, relDepth: number): boolean {
    if (manualExpanded.has(id)) return true;
    if (manualCollapsed.has(id)) return false;
    return relDepth < COLLAPSE_FROM_DEPTH;
  }

  const handleToggleExpand = useCallback(
    async (node: SubtreeNode, relDepth: number) => {
      const currentlyExpanded = isNodeExpanded(node.id, relDepth);

      if (currentlyExpanded) {
        setManualCollapsed((prev) => new Set([...prev, node.id]));
        setManualExpanded((prev) => {
          const next = new Set(prev);
          next.delete(node.id);
          return next;
        });
        return;
      }

      // Mark as manually expanded
      setManualExpanded((prev) => new Set([...prev, node.id]));
      setManualCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });

      // Lazy-fetch if at deep node and children not yet loaded
      const hasChildren = (childMap.get(node.id) ?? []).length > 0;
      if (relDepth >= COLLAPSE_FROM_DEPTH && !hasChildren) {
        setLoadingIds((prev) => new Set([...prev, node.id]));
        try {
          const res = await fetch(`/api/cards/${node.id}/children?depth=3`);
          if (res.ok) {
            const json: unknown = await res.json();
            const payload = subtreeResponseSchema.parse(json);
            setExtraDescendants((prev) => {
              // Avoid duplicate node IDs
              const existingIds = new Set(prev.map((n) => n.id));
              const newNodes = [payload.root, ...payload.descendants].filter(
                (n) => !existingIds.has(n.id),
              );
              return [...prev, ...newNodes];
            });
          }
        } catch {
          // non-fatal — expand shows empty children
        } finally {
          setLoadingIds((prev) => {
            const next = new Set(prev);
            next.delete(node.id);
            return next;
          });
        }
      }
    },
    // isNodeExpanded and childMap are derived from render-time state/props, recreated each render.
    // The callback must always use fresh versions. Omit from deps and use a ref-style approach
    // would overcomplicate; the async path here is safe since state setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootDepth, manualExpanded, manualCollapsed, childMap],
  );

  const handlePromote = useCallback(
    async (node: SubtreeNode) => {
      const res = await fetch(`/api/cards/${node.id}/promote`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Promote failed.");
      }
      await refresh();
    },
    [refresh],
  );

  function handleShowMore(parentId: string, currentCount: number) {
    setShownCountMap((prev) => {
      const next = new Map(prev);
      next.set(parentId, currentCount + SIBLINGS_PAGE_SIZE);
      return next;
    });
  }

  // Loading skeleton
  if (isLoading) {
    return (
      <section aria-labelledby="subcards-heading" aria-busy="true">
        <h3
          id="subcards-heading"
          className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3"
        >
          Sub-cards
        </h3>
        <div className="space-y-2" aria-label="Loading sub-cards">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-7 bg-slate-100 animate-pulse rounded-md"
              aria-hidden="true"
            />
          ))}
        </div>
      </section>
    );
  }

  // Error state
  if (error) {
    return (
      <section aria-labelledby="subcards-heading">
        <h3
          id="subcards-heading"
          className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3"
        >
          Sub-cards
        </h3>
        <div className="flex items-center gap-3 text-sm text-red-600">
          <span>Couldn&apos;t load sub-cards.</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="subcards-heading">
      <div className="flex items-center justify-between mb-3">
        <h3
          id="subcards-heading"
          className="text-xs font-semibold text-slate-500 uppercase tracking-wide"
        >
          Sub-cards
          {descendants.length > 0 && (
            <span className="ml-1.5 text-slate-400 font-normal normal-case">
              ({descendants.length})
            </span>
          )}
        </h3>
        {root && (
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            aria-expanded={showAddForm}
            className="text-xs text-blue-600 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
          >
            {showAddForm ? "Cancel" : "+ Add sub-card"}
          </button>
        )}
      </div>

      {showAddForm && root && (
        <AddSubcardForm
          boardId={boardId}
          parentCardId={cardId}
          columnId={columnId}
          assigneeId={root.assigneeId ?? ""}
          onCreated={() => {
            setShowAddForm(false);
            void refresh();
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {descendants.length === 0 && !showAddForm && (
        <p className="text-sm text-slate-400 italic">
          No sub-cards yet. Break this card into smaller pieces by adding
          sub-cards.
        </p>
      )}

      {descendants.length > 0 && (
        <TreeList
          parentId={cardId}
          childMap={childMap}
          rootDepth={rootDepth}
          isNodeExpanded={isNodeExpanded}
          loadingIds={loadingIds}
          onToggleExpand={handleToggleExpand}
          onPromote={handlePromote}
          onOpenCard={onOpenCard}
          shownCountMap={shownCountMap}
          onShowMore={handleShowMore}
        />
      )}
    </section>
  );
}
