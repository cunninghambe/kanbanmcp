/* ============================================================
   KanbanMCP — Card detail modal
   ============================================================ */

function MetaRow({ label, children, accent }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "92px 1fr",
      gap: 12,
      alignItems: "center",
      padding: "10px 16px",
      borderBottom: "1px solid var(--line-faint)",
      ...(accent ? { background: "var(--accent-tint)" } : {}),
    }}>
      <span className="eyebrow" style={{ fontSize: 9, color: "var(--fg-3)" }}>{label}</span>
      <div style={{ fontSize: 13, color: "var(--fg-1)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {children}
      </div>
    </div>
  );
}

function Subrow({ depth, id, title, status, assignee, agent, ai, last, expanded = true, isLast }) {
  // simple indent tree row
  return (
    <div style={{
      display: "flex", alignItems: "stretch", gap: 0,
      borderTop: depth === 0 ? "1px solid var(--line-faint)" : "0",
    }}>
      {/* indent guides */}
      {Array.from({ length: depth }).map((_, i) => (
        <div key={i} style={{
          width: 20,
          borderRight: "1px solid var(--line-faint)",
          marginRight: 0,
          flexShrink: 0,
        }} />
      ))}
      <div style={{ flex: 1, padding: "8px 12px 8px 8px", display: "flex", alignItems: "center", gap: 10, borderTop: depth > 0 ? "1px solid var(--line-faint)" : 0 }}>
        {depth > 0 && (
          <span className="mono" style={{ color: "var(--fg-4)", fontSize: 12, marginLeft: -2 }}>
            └
          </span>
        )}
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", minWidth: 56 }}>{id}</span>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase",
          padding: "1px 6px", border: "1px solid var(--line)",
          color: status === "done" ? "var(--ok)" : status === "review" ? "var(--warn)" : status === "doing" ? "var(--accent)" : "var(--fg-3)",
          borderColor: status === "done" ? "var(--ok)" : status === "review" ? "var(--warn)" : status === "doing" ? "var(--accent)" : "var(--line)",
        }}>
          {status === "doing" ? "wip" : status}
        </span>
        <span style={{ flex: 1, fontSize: 13, color: "var(--fg-1)", letterSpacing: "-0.005em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        {agent && <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", color: "var(--fg-3)" }}>[agent]</span>}
        {ai && <Icon name="sparkles" size={11} color="var(--accent)" stroke={1.75} />}
        {assignee && <Avatar name={assignee} size="sm" />}
      </div>
    </div>
  );
}

function CardModalScreen() {
  return (
    <div data-screen-label="02 Card detail" style={{
      width: 1440, height: 900,
      display: "flex", overflow: "hidden",
      background: "var(--bg-0)",
      fontFamily: "var(--font-body)",
      color: "var(--fg-1)",
    }}>
      <Sidebar active="board" boardId="core" />

      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--bg-1)" }}>
        {/* Header */}
        <header style={{
          height: 64,
          borderBottom: "1px solid var(--line)",
          background: "var(--bg-1)",
          padding: "0 24px",
          display: "flex", alignItems: "center", gap: 16,
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--fg-3)", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
              core / m1 / <span style={{ color: "var(--fg-2)" }}>M1-091</span>
              <span style={{ color: "var(--fg-4)" }}>›</span>
              <span style={{ color: "var(--accent)" }}>M1-093</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)", letterSpacing: "0.08em" }}>M1-093</span>
              <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--fg-0)", letterSpacing: "-0.015em" }}>
                queue worker — 3× retry with exponential backoff on 429 / 5xx
              </h1>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="btn"><Icon name="git-fork" size={13}/> sub-issue</button>
            <button className="btn"><Icon name="link" size={13}/> copy link</button>
            <button className="btn"><Icon name="more-horizontal" size={13}/></button>
            <button className="btn btn--ghost"><Icon name="x" size={16}/></button>
          </div>
        </header>

        {/* Body — three columns: main, right rail */}
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 360px", minHeight: 0 }}>
          {/* MAIN */}
          <div style={{ overflow: "hidden", display: "flex", flexDirection: "column", borderRight: "1px solid var(--line)" }}>
            {/* description */}
            <section style={{ padding: "20px 28px", borderBottom: "1px solid var(--line)" }}>
              <div className="eyebrow" style={{ fontSize: 9 }}>/// description</div>
              <p style={{
                marginTop: 8, fontSize: 14, lineHeight: 1.6, color: "var(--fg-1)",
                maxWidth: 720,
              }}>
                Anthropic SDK throws on 429 / 5xx mid-pipeline. Queue currently <span className="mono" style={{ background: "var(--bg-3)", padding: "0 4px" }}>status=failed</span> on first hit which trips the AI Reviewer service user into posting an error comment.
              </p>
              <p style={{ marginTop: 10, fontSize: 14, lineHeight: 1.6, color: "var(--fg-1)", maxWidth: 720 }}>
                Acceptance:
              </p>
              <ul style={{ marginTop: 4, fontSize: 13, lineHeight: 1.8, color: "var(--fg-2)", paddingLeft: 18 }}>
                <li>retry up to <span className="mono" style={{ color: "var(--fg-1)" }}>3×</span> on 429 / 5xx with backoff <span className="mono">2^n · 1s + jitter</span></li>
                <li>permanent fail (4xx other than 429) → <span className="mono">status: failed</span> immediately</li>
                <li>worker emits <span className="mono">aiReview.retried</span> webhook on each attempt</li>
              </ul>
            </section>

            {/* sub-issues */}
            <section style={{ padding: "16px 28px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div className="eyebrow" style={{ fontSize: 9 }}>/// sub-issues</div>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em" }}>4 · 2 done</span>
                  <div style={{ width: 80, height: 2, background: "var(--bg-3)" }}>
                    <div style={{ width: "50%", height: "100%", background: "var(--ok)" }} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn--sm"><Icon name="plus" size={11}/> add</button>
                  <button className="btn btn--sm"><Icon name="chevrons-up-down" size={11}/></button>
                </div>
              </div>
              <div style={{ border: "1px solid var(--line)", background: "var(--bg-2)" }}>
                <Subrow depth={0} id="M1-093.1" title="extract Anthropic call into retry-wrapper module" status="done"   assignee="JR" />
                <Subrow depth={1} id="M1-093.1a" title="unit tests for 429 / 502 / 503 paths" status="done" assignee="JR" />
                <Subrow depth={0} id="M1-093.2" title="emit aiReview.retried webhook" status="doing"  assignee="JR" ai />
                <Subrow depth={1} id="M1-093.2a" title="add `attempt` and `nextRetryMs` to payload" status="todo" assignee="ZK" />
                <Subrow depth={0} id="M1-093.3" title="surface retry attempt # on artifact row in UI" status="todo"   assignee="BC" />
                <Subrow depth={0} id="M1-093.4" title="document fail-permanent semantics in docs/ai-review" status="review" assignee="AB" agent />
              </div>
            </section>

            {/* artifacts */}
            <section style={{ padding: "16px 28px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div className="eyebrow" style={{ fontSize: 9 }}>/// artifacts</div>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>3</span>
                </div>
                <button className="btn btn--sm"><Icon name="upload" size={11}/> upload</button>
              </div>

              <div style={{ border: "1px solid var(--line)", background: "var(--bg-2)" }}>
                {[
                  { name: "retry-policy.md",                size: "4.2 KB", mime: "text", uploaded: "1h ago by jr",  review: { status: "done",    score: "pass",  model: "claude-sonnet-4-6" } },
                  { name: "queue-worker-trace-jan20.log",   size: "812 KB", mime: "text", uploaded: "26m ago by jr", review: { status: "running", elapsed: "12s" } },
                  { name: "backoff-jitter-distribution.png",size: "94 KB",  mime: "img",  uploaded: "yday by zk",    review: { status: "skipped", reason: "ai-review off" } },
                ].map((a, i) => (
                  <div key={a.name} style={{
                    display: "grid",
                    gridTemplateColumns: "20px 1fr 90px 130px 180px",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 14px",
                    borderTop: i === 0 ? 0 : "1px solid var(--line-faint)",
                  }}>
                    <Icon name={a.mime === "img" ? "image" : "file-text"} size={14} color="var(--fg-3)" />
                    <span className="mono" style={{ fontSize: 12, color: "var(--fg-1)" }}>{a.name}</span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em" }}>{a.size}</span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{a.uploaded}</span>
                    {a.review.status === "done" && (
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="pip pip--ok" />
                        <span className="mono" style={{ fontSize: 10, color: "var(--ok)", letterSpacing: "0.1em", textTransform: "uppercase" }}>ai review · pass</span>
                        <span className="mono" style={{ fontSize: 9, color: "var(--fg-3)" }}>{a.review.model}</span>
                      </span>
                    )}
                    {a.review.status === "running" && (
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="pip pip--accent" style={{ animation: "blink 1s steps(1) infinite" }} />
                        <span className="mono" style={{ fontSize: 10, color: "var(--accent)", letterSpacing: "0.1em", textTransform: "uppercase" }}>ai review · {a.review.elapsed} [•••]</span>
                      </span>
                    )}
                    {a.review.status === "skipped" && (
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="pip" />
                        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>skipped · {a.review.reason}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* comments */}
            <section style={{ padding: "16px 28px", flex: 1, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div className="eyebrow" style={{ fontSize: 9 }}>/// comments</div>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>8</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn--sm">all</button>
                  <button className="btn btn--sm" style={{ background: "var(--bg-3)" }}>activity</button>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {/* AI Reviewer comment — structured findings (variant C, canonical) */}
                <div style={{ display: "flex", gap: 12 }}>
                  <Avatar ai size="md" />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>AI Reviewer</span>
                      <span className="mono" style={{ fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.12em", textTransform: "uppercase", padding: "0 5px", border: "1px solid var(--line)" }}>AI</span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>· retry-policy.md · 1h ago · sonnet-4-6</span>
                      <span style={{ flex: 1 }} />
                      <span className="mono" style={{ fontSize: 10, color: "var(--ok)", letterSpacing: "0.1em", textTransform: "uppercase" }}>● pass</span>
                    </div>

                    <div style={{
                      fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55,
                      paddingBottom: 8, borderBottom: "1px solid var(--line-faint)", marginBottom: 6,
                    }}>
                      Spec is internally consistent. <span style={{ color: "var(--warn)" }}>1 warning</span>, <span style={{ color: "var(--fg-3)" }}>1 note</span>.
                    </div>

                    {[
                      { sev: "warn", color: "var(--warn)", title: "Retry-After header not honoured", body: <>On 429, current draft uses <span className="mono">2^n</span> jitter only. Clamp to server-supplied window if present: <span className="mono" style={{ background: "var(--bg-3)", padding: "0 4px" }}>max(2^n + jitter, Retry-After)</span>.</> },
                      { sev: "note", color: "var(--fg-3)", title: "Jitter bounds unspecified",       body: "Tests will be flaky without a max jitter cap. Suggest ±30% deterministic via seed." },
                      { sev: "ok",   color: "var(--ok)",   title: "Permanent-fail semantics clear",  body: "Non-429 4xx → status: failed reads as intended." },
                    ].map((f, i) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "16px 1fr", gap: 8, padding: "6px 0", borderTop: i === 0 ? 0 : "1px solid var(--line-faint)" }}>
                        <div style={{ paddingTop: 6 }}>
                          <span style={{ display: "inline-block", width: 7, height: 7, background: f.color }} />
                        </div>
                        <div>
                          <div className="mono" style={{ fontSize: 10, color: f.color, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                            [{String(i + 1).padStart(2, "0")}] {f.sev}
                          </div>
                          <div style={{ fontSize: 13, color: "var(--fg-0)", marginTop: 2, fontWeight: 500, letterSpacing: "-0.005em" }}>{f.title}</div>
                          <div style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 2, lineHeight: 1.5 }}>{f.body}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Human comment */}
                <div style={{ display: "flex", gap: 12 }}>
                  <Avatar name="ZK" size="md" />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>Zora K.</span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>· 42m ago</span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55 }}>
                      Good catch — I'll add the clamp in <span className="mono" style={{ background: "var(--bg-3)", padding: "0 4px" }}>retry-wrapper.ts</span>. Want to keep deterministic backoff in tests so let's gate it on <span className="mono">Retry-After != null</span>.
                    </div>
                  </div>
                </div>

                {/* Agent comment */}
                <div style={{ display: "flex", gap: 12 }}>
                  <Avatar name="auto" size="md" color="#0A0A0A" />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>auto-cli</span>
                      <span className="mono" style={{ fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.12em", textTransform: "uppercase", padding: "0 5px", border: "1px solid var(--line)" }}>AGENT</span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>· via mcp · 18m ago</span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55 }}>
                      Opened sub-issue <span className="mono" style={{ color: "var(--accent)" }}>M1-093.2a</span> · added `attempt` and `nextRetryMs` to webhook payload schema; tests passing locally.
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* composer */}
            <div style={{ borderTop: "1px solid var(--line)", padding: 16, background: "var(--bg-1)" }}>
              <div style={{ border: "1px solid var(--line)", background: "var(--bg-2)", padding: 10 }}>
                <div style={{ fontSize: 13, color: "var(--fg-3)", padding: "4px 2px" }}>write a comment, or <span className="mono" style={{ color: "var(--fg-2)" }}>/ai</span> to request a review…</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
                  <div style={{ display: "flex", gap: 8, color: "var(--fg-3)" }}>
                    <Icon name="bold" size={13} /><Icon name="italic" size={13} /><Icon name="code" size={13} /><Icon name="link" size={13} /><Icon name="at-sign" size={13} /><Icon name="paperclip" size={13} />
                  </div>
                  <button className="btn btn--primary btn--sm">comment →</button>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT RAIL */}
          <aside style={{ overflow: "auto", background: "var(--bg-1)" }}>
            {/* Meta */}
            <div style={{ borderBottom: "1px solid var(--line)" }}>
              <MetaRow label="status">
                <span className="pip pip--accent" />
                <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>in progress</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", marginLeft: "auto" }}>changed 2h ago</span>
              </MetaRow>
              <MetaRow label="priority">
                <span style={{ width: 3, height: 12, background: "var(--p-high)", display: "inline-block" }} />
                <span>high</span>
              </MetaRow>
              <MetaRow label="sprint">
                <span className="mono" style={{ fontSize: 12 }}>s11</span>
                <span style={{ color: "var(--fg-3)", fontSize: 11 }}>· ends fri</span>
              </MetaRow>
              <MetaRow label="due">
                <Icon name="calendar" size={12} color="var(--fg-3)" />
                <span style={{ color: "var(--accent)", fontWeight: 500 }}>today · 5pm</span>
              </MetaRow>
              <MetaRow label="labels">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 8px", border: "1px solid var(--line)", fontSize: 11 }}>
                  <span style={{ width: 6, height: 6, background: "#2A6FDB" }} /> ai-review
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 8px", border: "1px solid var(--line)", fontSize: 11 }}>
                  <span style={{ width: 6, height: 6, background: "#0EA5A4" }} /> perf
                </span>
              </MetaRow>
              <MetaRow label="parent">
                <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>M1-091</span>
                <span style={{ color: "var(--fg-3)", fontSize: 11 }}>iron-session rotation…</span>
              </MetaRow>
            </div>

            {/* Roles + signoffs */}
            <div style={{ borderBottom: "1px solid var(--line)" }}>
              <div style={{ padding: "14px 16px 6px" }}>
                <div className="eyebrow" style={{ fontSize: 9 }}>/// roles · signoffs</div>
              </div>
              {[
                { role: "assignee",  user: "JR", name: "Jules Reyes",   status: null,            req: false },
                { role: "reviewer",  user: "ZK", name: "Zora K.",       status: "approved",      req: true },
                { role: "approver",  user: "BC", name: "beth c.",        status: "pending",       req: true },
              ].map(r => (
                <div key={r.role} style={{ padding: "10px 16px", borderTop: "1px solid var(--line-faint)", display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="eyebrow" style={{ fontSize: 9, width: 60, color: "var(--fg-3)" }}>{r.role}</span>
                  <Avatar name={r.user} size="sm" />
                  <span style={{ fontSize: 12, color: "var(--fg-1)", flex: 1 }}>{r.name}</span>
                  {r.status === "approved" && <Chip tone="ok" dot>approved</Chip>}
                  {r.status === "pending"  && <Chip dot>pending</Chip>}
                </div>
              ))}
              <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line-faint)", display: "flex", gap: 6 }}>
                <button className="btn btn--sm" style={{ flex: 1 }}>request changes</button>
                <button className="btn btn--sm btn--primary" style={{ flex: 1 }}>approve →</button>
              </div>
            </div>

            {/* AI auto-review */}
            <div style={{ borderBottom: "1px solid var(--line)" }}>
              <div style={{ padding: "14px 16px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div className="eyebrow" style={{ fontSize: 9 }}>/// ai auto-review</div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ok)" }}>
                  <span className="pip pip--ok" /> ON
                </span>
              </div>
              <div style={{ padding: "0 16px 14px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, fontSize: 11, lineHeight: 1.7 }}>
                  <span className="mono" style={{ color: "var(--fg-3)" }}>model</span>
                  <span className="mono" style={{ color: "var(--fg-1)" }}>claude-sonnet-4-6</span>
                  <span className="mono" style={{ color: "var(--fg-3)" }}>rubric</span>
                  <span className="mono" style={{ color: "var(--fg-1)" }}>← inherits M1-091</span>
                  <span className="mono" style={{ color: "var(--fg-3)" }}>scope</span>
                  <span className="mono" style={{ color: "var(--fg-1)" }}>desc + artifacts</span>
                  <span className="mono" style={{ color: "var(--fg-3)" }}>last run</span>
                  <span className="mono" style={{ color: "var(--ok)" }}>● 1h ago · pass</span>
                </div>
              </div>
            </div>

            {/* Activity */}
            <div>
              <div style={{ padding: "14px 16px 10px" }}>
                <div className="eyebrow" style={{ fontSize: 9 }}>/// activity</div>
              </div>
              {[
                ["1h",  "AI Reviewer", "posted review · retry-policy.md", "ai"],
                ["2h",  "JR",          "moved to in progress",            null],
                ["3h",  "ZK",          "approved signoff · reviewer",     "ok"],
                ["4h",  "auto-cli",    "created M1-093.4",                "agent"],
                ["6h",  "BC",          "set reviewer to Zora K.",         null],
                ["yday","JR",          "created card",                    null],
              ].map(([t, who, what, tag], i) => (
                <div key={i} style={{ padding: "8px 16px", borderTop: "1px solid var(--line-faint)", display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12 }}>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", width: 32, paddingTop: 2 }}>{t}</span>
                  <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{who}</span>
                  <span style={{ color: "var(--fg-2)", flex: 1 }}>{what}</span>
                  {tag === "ai"    && <span className="mono" style={{ fontSize: 8, padding: "1px 4px", border: "1px solid var(--line)", color: "var(--accent)", borderColor: "var(--accent)", letterSpacing: "0.1em", textTransform: "uppercase" }}>AI</span>}
                  {tag === "agent" && <span className="mono" style={{ fontSize: 8, padding: "1px 4px", border: "1px solid var(--line)", color: "var(--fg-3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>AGT</span>}
                  {tag === "ok"    && <span className="pip pip--ok" style={{ marginTop: 4 }} />}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { CardModalScreen });
