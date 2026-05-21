/* ============================================================
   KanbanMCP — Variations: Priority / status indicators
   3 ways to represent priority on a kanban card.
   ============================================================ */

function PrioCardBase({ children, accent }) {
  return (
    <div style={{
      background: "var(--bg-2)",
      border: "1px solid var(--line)",
      padding: 12,
      display: "flex", flexDirection: "column", gap: 6,
      width: 280,
      ...(accent ? { boxShadow: `inset 3px 0 0 ${accent}` } : {}),
    }}>
      {children}
    </div>
  );
}

function PrioVariantA() {
  // Left-edge bar (canonical) — color is the priority itself
  const items = [
    { id: "M1-101", title: "AI review degrades silently when PDF extract > 10MB", prio: "critical", color: "var(--p-critical)" },
    { id: "M1-097", title: "Reparent endpoint cycle-detection invariants",         prio: "high",     color: "var(--p-high)" },
    { id: "M1-088", title: "Materialised path recompute is O(n²) on > 500 nodes", prio: "medium",   color: "var(--p-medium)" },
    { id: "M1-064", title: "Email digest: skip user with 0 assignments",          prio: "low",      color: "var(--p-low)" },
  ];
  return (
    <div data-screen-label="priority · A · edge bar" style={{ padding: 24, background: "var(--bg-0)", width: 640, display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <div className="eyebrow" style={{ fontSize: 10 }}>[a] // edge bar</div>
        <p style={{ marginTop: 6, fontSize: 13, color: "var(--fg-2)", maxWidth: 480 }}>
          3px coloured inset on the card's left edge. Reads from the column scan; consistent vertical scan-line per priority.
        </p>
      </header>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map(c => (
          <PrioCardBase key={c.id} accent={c.color}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em" }}>{c.id}</span>
              <span className="mono" style={{ fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: c.color }}>{c.prio}</span>
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-0)", letterSpacing: "-0.005em" }}>{c.title}</div>
          </PrioCardBase>
        ))}
      </div>
    </div>
  );
}

function PrioVariantB() {
  // Mono pill: [P1] / [P2] / [P3] / [P4]
  const items = [
    { id: "M1-101", title: "AI review degrades silently when PDF extract > 10MB", pip: "P1", tone: "var(--p-critical)" },
    { id: "M1-097", title: "Reparent endpoint cycle-detection invariants",         pip: "P2", tone: "var(--p-high)" },
    { id: "M1-088", title: "Materialised path recompute is O(n²) on > 500 nodes", pip: "P3", tone: "var(--p-medium)" },
    { id: "M1-064", title: "Email digest: skip user with 0 assignments",          pip: "P4", tone: "var(--p-low)" },
  ];
  return (
    <div data-screen-label="priority · B · mono pill" style={{ padding: 24, background: "var(--bg-0)", width: 640, display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <div className="eyebrow" style={{ fontSize: 10 }}>[b] // mono pill</div>
        <p style={{ marginTop: 6, fontSize: 13, color: "var(--fg-2)", maxWidth: 480 }}>
          <span className="mono">[P1]–[P4]</span> bracketed identifier in the id row. Reads like a Linux runlevel; reinforces the cli/control-plane tone.
        </p>
      </header>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map(c => (
          <PrioCardBase key={c.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em" }}>{c.id}</span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em",
                  padding: "1px 5px", border: `1px solid ${c.tone}`, color: c.tone,
                }}>
                  [{c.pip}]
                </span>
              </div>
              <span className="pip" />
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-0)", letterSpacing: "-0.005em" }}>{c.title}</div>
          </PrioCardBase>
        ))}
      </div>
    </div>
  );
}

function PrioVariantC() {
  // Tally / bar-glyph
  const items = [
    { id: "M1-101", title: "AI review degrades silently when PDF extract > 10MB", n: 4, tone: "var(--p-critical)", label: "P1" },
    { id: "M1-097", title: "Reparent endpoint cycle-detection invariants",         n: 3, tone: "var(--p-high)",     label: "P2" },
    { id: "M1-088", title: "Materialised path recompute is O(n²) on > 500 nodes", n: 2, tone: "var(--p-medium)",   label: "P3" },
    { id: "M1-064", title: "Email digest: skip user with 0 assignments",          n: 1, tone: "var(--p-low)",      label: "P4" },
  ];
  return (
    <div data-screen-label="priority · C · tally" style={{ padding: 24, background: "var(--bg-0)", width: 640, display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <div className="eyebrow" style={{ fontSize: 10 }}>[c] // tally bars</div>
        <p style={{ marginTop: 6, fontSize: 13, color: "var(--fg-2)", maxWidth: 480 }}>
          Stacked rectangles like a signal-strength meter. Quantitative-feeling — works well when sorting visually by priority across a long column.
        </p>
      </header>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map(c => (
          <PrioCardBase key={c.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em" }}>{c.id}</span>
              <div style={{ display: "flex", gap: 2, alignItems: "flex-end" }}>
                {[1,2,3,4].map(i => (
                  <span key={i} style={{
                    width: 4,
                    height: 4 + i * 2,
                    background: i <= c.n ? c.tone : "var(--bg-3)",
                  }} />
                ))}
              </div>
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-0)", letterSpacing: "-0.005em" }}>{c.title}</div>
          </PrioCardBase>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { PrioVariantA, PrioVariantB, PrioVariantC });
