/* ============================================================
   KanbanMCP — Board screen (main kanban view)
   ============================================================ */

// Sample cards — content fits the M1 "review workflow" milestone
const CARDS = {
  todo: [
    { id: "M1-101", prio: "critical", title: "AI review pipeline degrades silently when PDF extract exceeds 10MB cap", labels: ["bug", "ai-review"], assignee: "JR", due: "2d overdue", overdue: true, subs: 3, comments: 4, ai: true },
    { id: "M1-097", prio: "high",     title: "Reparent endpoint — strengthen cycle-detection invariants",            labels: ["api"],              assignee: "ZK", due: "due tue",      subs: 0, comments: 7, ai: false, agent: true },
    { id: "M1-088", prio: "medium",   title: "Materialised path recompute is O(n²) on subtrees > 500 nodes",        labels: ["perf"],             assignee: "AB", due: "due thu",      subs: 5, comments: 2, ai: false },
    { id: "M1-084", prio: null,       title: "Helpdesk → board card promotion (one-way for M1)",                    labels: ["helpdesk", "spec"], assignee: null, due: null,            subs: 0, comments: 0, ai: false },
    { id: "M1-079", prio: "high",     title: "Signoff panel — visual delta APPROVED / REQUESTED_CHANGES / REJECTED", labels: ["ui"],              assignee: "BC", due: "due fri",      subs: 2, comments: 1, ai: false },
    { id: "M1-064", prio: "low",      title: "Email digest: skip user with 0 assignments",                          labels: [],                   assignee: "AB", due: null,            subs: 0, comments: 0, ai: false },
  ],
  doing: [
    { id: "M1-093", prio: "high",     title: "Queue worker — 3× retry w/ exponential backoff on 429/5xx",           labels: ["ai-review"],        assignee: "JR", due: "due today",     subs: 4, comments: 8, ai: true, agent: true },
    { id: "M1-091", prio: "medium",   title: "iron-session rotation on org switch",                                  labels: ["sec"],              assignee: "BC", due: "due wed",       subs: 1, comments: 3, ai: false },
    { id: "M1-082", prio: "medium",   title: "Per-card aiReviewParams inheritance walker",                           labels: ["ai-review"],        assignee: "ZK", due: null,             subs: 2, comments: 2, ai: true },
    { id: "M1-080", prio: null,       title: "Sprint burndown — denominator excludes promoted cards",                labels: ["sprint"],           assignee: "AB", due: "due mon",       subs: 0, comments: 1, ai: false },
  ],
  review: [
    { id: "M1-076", prio: "high",     title: "Webhook payload schema for `review.completed`",                        labels: ["api", "webhook"],   assignee: "ZK", reviewer: "BC", due: "review · 2h",   subs: 0, comments: 6, ai: false, signoffOk: 1, signoffPending: 1 },
    { id: "M1-073", prio: "medium",   title: "PDF text extractor handles inline images",                             labels: ["ai-review"],        assignee: "JR", reviewer: "AB", due: "review · 1d",   subs: 0, comments: 4, ai: true, signoffOk: 0, signoffPending: 2 },
    { id: "M1-069", prio: null,       title: "Replace shimmer skeletons with 1px hairline outline",                 labels: ["ui"],               assignee: "BC", reviewer: "JR", due: null,             subs: 0, comments: 2, ai: false, signoffChanges: 1 },
  ],
  done: [
    { id: "M1-074", prio: null,       title: "Card detail: collapse subtree past depth 3",                          labels: ["ui"],               assignee: "AB", due: null,           subs: 0, comments: 3, ai: false, doneDate: "yday" },
    { id: "M1-067", prio: null,       title: "404 (not 403) on cross-org card lookup",                              labels: ["sec"],              assignee: "ZK", due: null,           subs: 0, comments: 5, ai: false, doneDate: "mon" },
    { id: "M1-061", prio: null,       title: "Drop translucent panel fills throughout board UI",                    labels: ["ui"],               assignee: "BC", due: null,           subs: 0, comments: 1, ai: false, doneDate: "mon" },
    { id: "M1-058", prio: "low",      title: "Eval suite coverage 92% → 96%",                                       labels: ["tests"],            assignee: "JR", due: null,           subs: 0, comments: 0, ai: false, doneDate: "sun" },
  ],
};

const LABEL_COLORS = {
  bug:        "#D11629",
  "ai-review":"#2A6FDB",
  api:        "#1F8A5B",
  helpdesk:   "#B87A00",
  spec:       "#8A8472",
  ui:         "#7A4DD3",
  perf:       "#0EA5A4",
  sec:        "#0A0A0A",
  webhook:    "#4D7CFF",
  sprint:     "#5A574E",
  tests:      "#1F8A5B",
};

function MiniCard({ c, columnId }) {
  const priorityClass = c.prio ? `kc--prio-${c.prio}` : "";
  return (
    <div className={`kc ${priorityClass}`}>
      {/* Top row: id + status pip */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="kc__id">{c.id}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {c.agent && (
            <span title="created by agent" className="mono" style={{ fontSize: 9, letterSpacing: "0.12em", color: "var(--fg-3)" }}>
              [agent]
            </span>
          )}
          {c.ai && <Icon name="sparkles" size={11} color="var(--accent)" stroke={1.75} />}
        </div>
      </div>

      {/* Labels */}
      {c.labels && c.labels.length > 0 && (
        <div className="labels">
          {c.labels.map(l => (
            <span key={l} className="label-bar" title={l} style={{ background: LABEL_COLORS[l] || "var(--fg-3)" }} />
          ))}
        </div>
      )}

      {/* Title */}
      <div className="kc__title">{c.title}</div>

      {/* Subissue progress (if any) */}
      {c.subs > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
          <Icon name="git-fork" size={11} color="var(--fg-3)" />
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
            {c.subs} sub-issues
          </span>
          <div style={{ flex: 1, height: 2, background: "var(--bg-3)", marginLeft: 4 }}>
            <div style={{ width: `${(c.subs > 3 ? 60 : 33)}%`, height: "100%", background: "var(--ok)" }} />
          </div>
        </div>
      )}

      {/* Signoff state (review column) */}
      {columnId === "review" && (
        <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
          {Array.from({ length: c.signoffOk || 0 }).map((_, i) =>
            <span key={"o" + i} className="pip pip--ok" title="approved" />)}
          {Array.from({ length: c.signoffChanges || 0 }).map((_, i) =>
            <span key={"c" + i} className="pip pip--warn" title="changes requested" />)}
          {Array.from({ length: c.signoffPending || 0 }).map((_, i) =>
            <span key={"p" + i} className="pip" title="pending" />)}
          <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", color: "var(--fg-3)", textTransform: "uppercase", marginLeft: 4 }}>
            {(c.signoffOk || 0) + (c.signoffChanges || 0)} / {(c.signoffOk || 0) + (c.signoffChanges || 0) + (c.signoffPending || 0)}
          </span>
        </div>
      )}

      {/* Footer */}
      <div className="kc__meta">
        <div className="kc__meta-left">
          {c.due && (
            <span style={{ color: c.overdue ? "var(--err)" : "var(--fg-2)", fontWeight: c.overdue ? 600 : 400 }}>
              {c.overdue && "✗ "}{c.due}
            </span>
          )}
          {c.doneDate && <span style={{ color: "var(--fg-3)" }}>✓ {c.doneDate}</span>}
          {c.comments > 0 && (
            <span style={{ color: "var(--fg-3)", display: "inline-flex", alignItems: "center", gap: 3 }}>
              <Icon name="message-square" size={10} color="var(--fg-3)" />
              {c.comments}
            </span>
          )}
        </div>
        {c.assignee ? (
          <div style={{ display: "flex", alignItems: "center", gap: -4, position: "relative" }}>
            {c.reviewer && (
              <span style={{ marginRight: -8, opacity: 0.7 }}>
                <Avatar name={c.reviewer} size="sm" />
              </span>
            )}
            <Avatar name={c.assignee} size="sm" />
          </div>
        ) : (
          <Avatar size="sm" name="?" color="var(--fg-4)" />
        )}
      </div>
    </div>
  );
}

function Column({ id, title, count, accent, children, isDone }) {
  return (
    <div style={{
      width: 280,
      flexShrink: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--bg-1)",
      border: "1px solid var(--line)",
      minHeight: 0,
    }}>
      {/* Column head */}
      <div style={{
        padding: "10px 12px",
        borderBottom: "1px solid var(--line)",
        display: "flex", alignItems: "center", gap: 8,
        background: "var(--bg-2)",
      }}>
        <span className={`pip ${accent ? `pip--${accent}` : ""}`} />
        <span className="mono" style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fg-1)", fontWeight: 500, flex: 1 }}>
          {title}
        </span>
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em" }}>
          {String(count).padStart(2, "0")}
        </span>
        <Icon name="plus" size={13} color="var(--fg-3)" />
      </div>

      {/* WIP limit hint */}
      {id === "doing" && (
        <div className="mono" style={{
          padding: "4px 12px",
          fontSize: 10,
          letterSpacing: "0.08em",
          color: "var(--fg-3)",
          borderBottom: "1px solid var(--line-faint)",
          background: "var(--bg-1)",
        }}>
          wip · 4 / 6
        </div>
      )}

      {/* Cards */}
      <div style={{
        padding: 8,
        display: "flex", flexDirection: "column", gap: 8,
        flex: 1, minHeight: 0,
        overflow: "hidden",
        ...(isDone ? { opacity: 0.85 } : {}),
      }}>
        {children}
      </div>
    </div>
  );
}

function BoardScreen() {
  const right = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {/* Search */}
      <div style={{
        height: 32, display: "flex", alignItems: "center", gap: 8,
        border: "1px solid var(--line)",
        background: "var(--bg-2)",
        padding: "0 10px",
        minWidth: 240,
      }}>
        <Icon name="search" size={13} color="var(--fg-3)" />
        <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)", letterSpacing: "0.04em", flex: 1 }}>find a card…</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", border: "1px solid var(--line)", padding: "1px 5px" }}>⌘k</span>
      </div>
      <button className="btn"><Icon name="filter" size={13} /> filter</button>
      <button className="btn"><Icon name="users" size={13} /> 4</button>
      <div style={{ width: 1, height: 20, background: "var(--line)" }} />
      <button className="btn"><Icon name="git-pull-request-arrow" size={13} /> sprint s11</button>
      <button className="btn btn--primary"><Icon name="plus" size={13} color="#fff" /> new card</button>
    </div>
  );

  return (
    <div data-screen-label="01 Board" style={{
      width: 1440, height: 900,
      display: "flex", overflow: "hidden",
      background: "var(--bg-0)",
      fontFamily: "var(--font-body)",
      color: "var(--fg-1)",
    }}>
      <Sidebar active="board" boardId="core" />

      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Topbar
          breadcrumb="core / boards / m1"
          title="m1 — review workflow"
          right={right}
        />

        {/* Filters / context bar */}
        <div style={{
          height: 40,
          borderBottom: "1px solid var(--line)",
          background: "var(--bg-1)",
          padding: "0 24px",
          display: "flex", alignItems: "center", gap: 16,
          flexShrink: 0,
        }}>
          <span className="eyebrow" style={{ fontSize: 9 }}>filter</span>
          <Chip>assignee · me</Chip>
          <Chip>label · ai-review</Chip>
          <Chip tone="accent">priority ≥ high</Chip>
          <button className="btn btn--ghost btn--sm" style={{ color: "var(--fg-3)" }}>+ add filter</button>

          <div style={{ flex: 1 }} />

          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--fg-3)", textTransform: "uppercase" }}>
            28 cards · 17 ai-review enabled · ai-queue [<span style={{ color: "var(--ok)" }}>● 2 running</span> / <span>4 pending</span>]
          </span>
        </div>

        {/* Board area */}
        <div style={{ flex: 1, padding: 16, display: "flex", gap: 12, overflow: "hidden", background: "var(--bg-0)" }}>
          <Column id="todo"   title="todo"        count={CARDS.todo.length}   accent={null}>
            {CARDS.todo.map(c => <MiniCard key={c.id} c={c} columnId="todo" />)}
          </Column>

          <Column id="doing"  title="in progress" count={CARDS.doing.length}  accent="accent">
            {CARDS.doing.map(c => <MiniCard key={c.id} c={c} columnId="doing" />)}
          </Column>

          <Column id="review" title="in review"   count={CARDS.review.length} accent="warn">
            {CARDS.review.map(c => <MiniCard key={c.id} c={c} columnId="review" />)}
          </Column>

          <Column id="done"   title="done"        count={CARDS.done.length}   accent="ok" isDone>
            {CARDS.done.map(c => <MiniCard key={c.id} c={c} columnId="done" />)}
          </Column>
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { BoardScreen, CARDS, MiniCard });
