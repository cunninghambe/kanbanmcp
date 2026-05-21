/* ============================================================
   KanbanMCP — Variations: Sub-issue tree
   3 ways to render the materialised-path hierarchy.
   ============================================================ */

const TREE = [
  { depth: 0, id: "M1-093",   title: "queue worker — 3× retry w/ exponential backoff", status: "doing",  who: "JR" },
  { depth: 1, id: "M1-093.1", title: "extract Anthropic call into retry-wrapper",       status: "done",   who: "JR" },
  { depth: 2, id: "M1-093.1a",title: "unit tests for 429 / 502 / 503 paths",            status: "done",   who: "JR" },
  { depth: 2, id: "M1-093.1b",title: "preserve aborted-by-user signal",                  status: "done",   who: "JR" },
  { depth: 1, id: "M1-093.2", title: "emit aiReview.retried webhook",                    status: "doing",  who: "ZK" },
  { depth: 2, id: "M1-093.2a",title: "add attempt + nextRetryMs to payload",            status: "todo",   who: "ZK" },
  { depth: 1, id: "M1-093.3", title: "surface attempt # on artifact row",                status: "todo",   who: "BC" },
  { depth: 1, id: "M1-093.4", title: "document fail-permanent semantics",                status: "review", who: "AB" },
];

const STATUS = {
  todo:   { label: "todo",  color: "var(--fg-2)",  border: "var(--line)" },
  doing:  { label: "wip",   color: "var(--accent)",border: "var(--accent)" },
  review: { label: "rev",   color: "var(--warn)",  border: "var(--warn)" },
  done:   { label: "done",  color: "var(--ok)",    border: "var(--ok)" },
};

function StatusTag({ status }) {
  const s = STATUS[status];
  return (
    <span style={{
      fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase",
      padding: "1px 6px", border: `1px solid ${s.border}`, color: s.color,
      width: 38, textAlign: "center", flexShrink: 0,
    }}>{s.label}</span>
  );
}

/* ---- A) Indent + vertical guide (canonical) ---- */
function TreeVariantA() {
  return (
    <div data-screen-label="tree · A · indent" style={{ padding: 24, background: "var(--bg-0)", width: 720 }}>
      <header style={{ marginBottom: 14 }}>
        <div className="eyebrow" style={{ fontSize: 10 }}>[a] // indent</div>
        <p style={{ marginTop: 6, fontSize: 13, color: "var(--fg-2)", maxWidth: 560 }}>
          Each level shifts right; left-side rules mark the lineage. Most direct mapping of the materialised path.
        </p>
      </header>
      <div style={{ border: "1px solid var(--line)", background: "var(--bg-2)" }}>
        {TREE.map((n, i) => (
          <div key={n.id} style={{ display: "flex", borderTop: i === 0 ? 0 : "1px solid var(--line-faint)" }}>
            {/* indent guides */}
            {Array.from({ length: n.depth }).map((_, d) => (
              <div key={d} style={{ width: 20, borderRight: "1px solid var(--line-faint)", flexShrink: 0 }} />
            ))}
            <div style={{ flex: 1, padding: "8px 12px 8px 8px", display: "flex", alignItems: "center", gap: 10 }}>
              {n.depth > 0 && (
                <span className="mono" style={{ color: "var(--fg-4)", fontSize: 12 }}>└</span>
              )}
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", minWidth: 70 }}>{n.id}</span>
              <StatusTag status={n.status} />
              <span style={{ flex: 1, fontSize: 13, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
              <Avatar name={n.who} size="sm" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- B) Outline numbering — no indent ---- */
function TreeVariantB() {
  // Build outline numbers: 1, 1.1, 1.1.1, ...
  const counters = [];
  const items = TREE.map(n => {
    counters.length = n.depth + 1;
    counters[n.depth] = (counters[n.depth] || 0) + 1;
    for (let i = n.depth + 1; i < counters.length; i++) counters[i] = 0;
    return { ...n, outline: counters.slice(0, n.depth + 1).join(".") };
  });

  return (
    <div data-screen-label="tree · B · outline" style={{ padding: 24, background: "var(--bg-0)", width: 720 }}>
      <header style={{ marginBottom: 14 }}>
        <div className="eyebrow" style={{ fontSize: 10 }}>[b] // outline</div>
        <p style={{ marginTop: 6, fontSize: 13, color: "var(--fg-2)", maxWidth: 560 }}>
          Numeric outline (1.1.2) carries hierarchy; rows stay flush-left. Maximum information density, copy-pastable into specs.
        </p>
      </header>
      <div style={{ border: "1px solid var(--line)", background: "var(--bg-2)" }}>
        {items.map((n, i) => (
          <div key={n.id} style={{
            display: "grid",
            gridTemplateColumns: "56px 72px 50px 1fr 28px",
            alignItems: "center", gap: 10,
            padding: "8px 12px",
            borderTop: i === 0 ? 0 : "1px solid var(--line-faint)",
          }}>
            <span className="mono" style={{
              fontSize: 11, color: n.depth === 0 ? "var(--fg-0)" : "var(--fg-3)",
              letterSpacing: "0.06em", fontWeight: n.depth === 0 ? 600 : 400,
            }}>
              {n.outline}
            </span>
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em" }}>{n.id}</span>
            <StatusTag status={n.status} />
            <span style={{ fontSize: 13, color: "var(--fg-1)", letterSpacing: "-0.005em" }}>{n.title}</span>
            <Avatar name={n.who} size="sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- C) Path-graph — boxes connected by lines (schematic) ---- */
function TreeVariantC() {
  // Two-column layout: depth-0 head on top, then children below as a schematic.
  const root = TREE[0];
  const lvl1 = TREE.filter(n => n.depth === 1);
  const kidsOf = (parentId) => TREE.filter(n => n.depth === 2 && n.id.startsWith(parentId + "."));

  const Box = ({ n, width = 220 }) => (
    <div style={{
      border: "1px solid var(--line)",
      background: "var(--bg-2)",
      padding: "8px 10px",
      width,
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em" }}>{n.id}</span>
        <StatusTag status={n.status} />
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.35, letterSpacing: "-0.005em" }}>{n.title}</div>
    </div>
  );

  return (
    <div data-screen-label="tree · C · path-graph" style={{ padding: 24, background: "var(--bg-0)", width: 720 }}>
      <header style={{ marginBottom: 14 }}>
        <div className="eyebrow" style={{ fontSize: 10 }}>[c] // path-graph</div>
        <p style={{ marginTop: 6, fontSize: 13, color: "var(--fg-2)", maxWidth: 560 }}>
          Parent at the head, branches drawn as schematic lines. Reads more like a blueprint than a list — useful for deep trees with parallel branches.
        </p>
      </header>
      <div style={{ padding: 12, border: "1px solid var(--line-faint)", background: "var(--bg-1)" }}>
        {/* root */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Box n={root} width={300} />
        </div>
        {/* trunk */}
        <div style={{ height: 16, borderLeft: "1px solid var(--line-strong)", marginLeft: "calc(50% - 1px)", width: 0 }} />
        {/* spine */}
        <div style={{ position: "relative", height: 12 }}>
          <div style={{ position: "absolute", left: 12, right: 12, top: 0, borderTop: "1px solid var(--line-strong)" }} />
          {lvl1.map((_, i) => (
            <div key={i} style={{
              position: "absolute",
              left: `calc(${(i + 0.5) * (100 / lvl1.length)}% - 0.5px)`,
              top: 0, bottom: 0, width: 1, background: "var(--line-strong)",
            }} />
          ))}
        </div>
        {/* lvl 1 row */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${lvl1.length}, 1fr)`, gap: 8 }}>
          {lvl1.map(n => {
            const ch = kidsOf(n.id);
            return (
              <div key={n.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>
                <Box n={n} width={150} />
                {ch.length > 0 && (
                  <>
                    <div style={{ height: 10, borderLeft: "1px solid var(--line-strong)", width: 0 }} />
                    {ch.map((k, i) => (
                      <React.Fragment key={k.id}>
                        <Box n={k} width={150} />
                        {i < ch.length - 1 && <div style={{ height: 6, borderLeft: "1px dashed var(--line)" }} />}
                      </React.Fragment>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TreeVariantA, TreeVariantB, TreeVariantC });
