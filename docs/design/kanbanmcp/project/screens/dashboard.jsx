/* ============================================================
   KanbanMCP — Dashboard (assigned-to-me feed)
   ============================================================ */

function QueueSection({ label, count, accent, children, hint }) {
  return (
    <section style={{
      border: "1px solid var(--line)",
      background: "var(--bg-1)",
    }}>
      <header style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--line)",
        display: "flex", alignItems: "center", gap: 10,
        background: "var(--bg-2)",
      }}>
        <span className={`pip ${accent ? `pip--${accent}` : ""}`} />
        <span className="eyebrow" style={{ fontSize: 10, color: "var(--fg-1)" }}>{label}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em" }}>
          {String(count).padStart(2, "0")}
        </span>
        <div style={{ flex: 1 }} />
        {hint && <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em" }}>{hint}</span>}
      </header>
      {children}
    </section>
  );
}

function QueueRow({ id, title, priority, due, overdue, sprint, status, age }) {
  const prioColor = priority ? {
    critical: "var(--p-critical)",
    high: "var(--p-high)",
    medium: "var(--p-medium)",
    low: "var(--p-low)",
  }[priority] : null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "4px 80px 1fr 90px 80px 86px",
      alignItems: "center",
      gap: 12,
      padding: "10px 16px 10px 0",
      borderTop: "1px solid var(--line-faint)",
      cursor: "pointer",
    }}>
      <span style={{ width: 3, height: 24, background: prioColor || "transparent" }} />
      <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.06em" }}>{id}</span>
      <span style={{ fontSize: 13, color: "var(--fg-0)", letterSpacing: "-0.005em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase",
        padding: "1px 6px", border: "1px solid var(--line)", textAlign: "center",
        color: status === "doing" ? "var(--accent)" : status === "review" ? "var(--warn)" : status === "todo" ? "var(--fg-2)" : "var(--ok)",
        borderColor: status === "doing" ? "var(--accent)" : status === "review" ? "var(--warn)" : "var(--line)",
      }}>
        {status === "doing" ? "wip" : status}
      </span>
      <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>{sprint || "—"}</span>
      <span className="mono" style={{ fontSize: 11, color: overdue ? "var(--err)" : "var(--fg-2)", textAlign: "right", fontWeight: overdue ? 600 : 400 }}>
        {overdue && "✗ "}{due || age}
      </span>
    </div>
  );
}

function StatPanel({ label, value, sub, accent }) {
  return (
    <div style={{ padding: "16px 18px", borderRight: "1px solid var(--line)", flex: 1 }}>
      <div className="eyebrow" style={{ fontSize: 9 }}>{label}</div>
      <div style={{
        fontFamily: "var(--font-display)",
        fontSize: 32, fontWeight: 600,
        letterSpacing: "-0.025em",
        color: accent === "err" ? "var(--err)" : "var(--fg-0)",
        marginTop: 6, lineHeight: 1,
      }}>
        {value}
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 6, letterSpacing: "0.06em" }}>
        {sub}
      </div>
    </div>
  );
}

function DashboardScreen() {
  return (
    <div data-screen-label="03 Dashboard" style={{
      width: 1440, height: 900,
      display: "flex", overflow: "hidden",
      background: "var(--bg-0)",
      fontFamily: "var(--font-body)",
      color: "var(--fg-1)",
    }}>
      <Sidebar active="dashboard" boardId="" />

      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Topbar
          breadcrumb="hello, beth"
          title="your queue"
          mode="dashboard"
          right={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.06em" }}>
                wed 22 jan · <span style={{ color: "var(--fg-1)" }}>09:14</span>
              </span>
              <div style={{ width: 1, height: 20, background: "var(--line)" }} />
              <button className="btn"><Icon name="mail" size={13}/> digest preview</button>
              <button className="btn btn--primary"><Icon name="plus" size={13} color="#fff"/> new card</button>
            </div>
          }
        />

        {/* Top stats row */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--line)", background: "var(--bg-1)" }}>
          <StatPanel label="as assignee"  value="07" sub="3 due this week" />
          <StatPanel label="as reviewer"  value="04" sub="2 waiting on you · 16h sla" />
          <StatPanel label="as approver"  value="02" sub="1 fast-track" />
          <StatPanel label="overdue"      value="03" sub="oldest · 4d" accent="err" />
          <div style={{ padding: "16px 18px", flex: 1, display: "flex", flexDirection: "column" }}>
            <div className="eyebrow" style={{ fontSize: 9 }}>ai-review queue</div>
            <div style={{
              fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 600,
              letterSpacing: "-0.025em", color: "var(--fg-0)", marginTop: 6, lineHeight: 1,
            }}>
              06
              <span style={{ fontSize: 14, color: "var(--fg-3)", marginLeft: 6, letterSpacing: 0 }}>jobs</span>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span className="pip pip--ok" />2 done</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span className="pip pip--accent" />2 running</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span className="pip" />2 pending</span>
            </div>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, padding: 20, overflow: "auto", display: "grid", gridTemplateColumns: "1fr 360px", gap: 16 }}>
          {/* LEFT — queues */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <QueueSection label="needs you · reviewer" count={4} accent="warn" hint="oldest · 16h">
              <QueueRow id="M1-076" title="webhook payload schema for review.completed"           status="review" sprint="s11" priority="high"   due="review · 2h"   overdue />
              <QueueRow id="M1-073" title="PDF text extractor handles inline images"               status="review" sprint="s11" priority="medium" due="review · 1d"   />
              <QueueRow id="M1-069" title="replace shimmer skeletons with 1px hairline outline"   status="review" sprint="s11" priority={null}    due="review · 2d"   />
              <QueueRow id="M1-055" title="org switch — drop SWR cache for assignment counts"     status="review" sprint="s10" priority="low"    due="review · 3d"   />
            </QueueSection>

            <QueueSection label="needs you · approver" count={2} accent="accent" hint="approve to advance">
              <QueueRow id="M1-088" title="materialised path recompute is O(n²) on subtrees > 500" status="doing"  sprint="s11" priority="medium" due="due thu" />
              <QueueRow id="M1-079" title="signoff panel — visual delta APPROVED / REJECTED"       status="doing"  sprint="s11" priority="high"   due="due fri" />
            </QueueSection>

            <QueueSection label="assigned to you" count={7} hint="sorted by due">
              <QueueRow id="M1-091" title="iron-session rotation on org switch"                     status="doing"  sprint="s11" priority="medium" due="due wed" />
              <QueueRow id="M1-101" title="ai review degrades silently when PDF extract > 10MB"    status="todo"   sprint="s11" priority="critical" due="2d overdue" overdue />
              <QueueRow id="M1-058" title="eval suite coverage 92% → 96%"                          status="doing"  sprint="s11" priority="low"    due="due mon" />
              <QueueRow id="M1-084" title="helpdesk → board card promotion (one-way for M1)"       status="todo"   sprint="s11" priority={null}   due="due tue" />
              <QueueRow id="M1-061" title="drop translucent panel fills throughout board UI"       status="done"   sprint="s11" priority={null}   age="closed mon" />
              <QueueRow id="M1-049" title="seed: ai-reviewer service user idempotency"             status="done"   sprint="s10" priority={null}   age="closed sun" />
              <QueueRow id="M1-042" title="api-key auth bypass on /api/mcp manifest GET"           status="done"   sprint="s10" priority="high"   age="closed sat" />
            </QueueSection>
          </div>

          {/* RIGHT */}
          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Sprint progress */}
            <section style={{ border: "1px solid var(--line)", background: "var(--bg-1)" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span className="eyebrow" style={{ fontSize: 10, color: "var(--fg-1)" }}>/// sprint s11</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>day 3 / 5</span>
              </div>
              <div style={{ padding: 16 }}>
                <div style={{
                  fontFamily: "var(--font-display)", fontSize: 36, fontWeight: 600,
                  letterSpacing: "-0.025em", color: "var(--fg-0)", lineHeight: 1,
                }}>
                  41<span style={{ color: "var(--fg-3)", fontSize: 22, marginLeft: 6 }}>/ 78</span>
                </div>
                <div className="mono" style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 6, letterSpacing: "0.06em" }}>
                  points · 53% complete
                </div>

                {/* burndown bars (simple) */}
                <div style={{ marginTop: 16, display: "flex", alignItems: "flex-end", gap: 4, height: 70 }}>
                  {[78, 70, 66, 54, 41, 28, 12].map((v, i) => {
                    const ideal = [78, 65, 52, 39, 26, 13, 0][i];
                    const planned = i >= 4;
                    return (
                      <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
                        <div style={{
                          height: `${(v/78)*100}%`,
                          background: planned ? "var(--bg-3)" : "var(--fg-1)",
                          borderTop: planned ? "1px dashed var(--line-strong)" : 0,
                        }} />
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  {["mon","tue","wed","thu","fri","sat","sun"].map(d =>
                    <span key={d} className="mono" style={{ fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.06em" }}>{d}</span>
                  )}
                </div>
              </div>
            </section>

            {/* AI review queue detail */}
            <section style={{ border: "1px solid var(--line)", background: "var(--bg-1)" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span className="eyebrow" style={{ fontSize: 10, color: "var(--fg-1)" }}>/// ai-review queue</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--ok)" }}>● healthy</span>
              </div>
              <div>
                {[
                  { id: "M1-093.r2", target: "retry-policy.md",   model: "sonnet-4-6", state: "running", time: "12s" },
                  { id: "M1-073.r1", target: "card description",  model: "sonnet-4-6", state: "running", time: "4s"  },
                  { id: "M1-101.r3", target: "spec-overrun.pdf",  model: "sonnet-4-6", state: "pending", time: "—"  },
                  { id: "M1-079.r1", target: "card description",  model: "haiku-4-5",  state: "pending", time: "—"  },
                ].map((j, i) => (
                  <div key={j.id} style={{ padding: "8px 16px", borderTop: i === 0 ? 0 : "1px solid var(--line-faint)", display: "grid", gridTemplateColumns: "10px 1fr 70px", alignItems: "center", gap: 10 }}>
                    <span className={`pip ${j.state === "running" ? "pip--accent" : ""}`} style={{ animation: j.state === "running" ? "blink 1s steps(1) infinite" : "none" }} />
                    <div style={{ minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 11, color: "var(--fg-1)" }}>{j.target}</div>
                      <div className="mono" style={{ fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.06em" }}>{j.id} · {j.model}</div>
                    </div>
                    <span className="mono" style={{ fontSize: 10, color: j.state === "running" ? "var(--accent)" : "var(--fg-3)", textAlign: "right", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                      {j.state === "running" ? `${j.time} [•••]` : "pending"}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* Agent activity */}
            <section style={{ border: "1px solid var(--line)", background: "var(--bg-1)" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
                <span className="eyebrow" style={{ fontSize: 10, color: "var(--fg-1)" }}>/// agent activity · last 6h</span>
              </div>
              <div style={{ padding: "12px 16px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-2)", lineHeight: 1.85 }}>
                <div><span style={{ color: "var(--fg-3)" }}>08:42</span> <span style={{ color: "var(--accent)" }}>auto-cli</span> create_card → <span style={{ color: "var(--fg-1)" }}>M1-101</span></div>
                <div><span style={{ color: "var(--fg-3)" }}>08:51</span> <span style={{ color: "var(--accent)" }}>auto-cli</span> toggle_ai_review → on</div>
                <div><span style={{ color: "var(--fg-3)" }}>09:03</span> <span style={{ color: "var(--accent)" }}>auto-cli</span> create_subcard → <span style={{ color: "var(--fg-1)" }}>M1-093.4</span></div>
                <div><span style={{ color: "var(--fg-3)" }}>09:11</span> <span style={{ color: "var(--accent)" }}>auto-cli</span> add_comment → <span style={{ color: "var(--fg-1)" }}>M1-093</span></div>
                <div><span style={{ color: "var(--fg-3)" }}>09:12</span> <span style={{ color: "var(--accent)" }}>auto-cli</span> move_card <span style={{ color: "var(--fg-3)" }}>→</span> <span style={{ color: "var(--ok)" }}>ok</span></div>
              </div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { DashboardScreen });
