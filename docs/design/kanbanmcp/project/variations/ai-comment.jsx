/* ============================================================
   KanbanMCP — Variations: AI review comment styles
   All "quiet" treatments — AI looks like any other reviewer,
   distinguished only by a small mono tag + sparkle avatar.
   ============================================================ */

function AiCommentWrap({ children, label, blurb }) {
  return (
    <div style={{ padding: 24, background: "var(--bg-0)", width: 680, display: "flex", flexDirection: "column", gap: 14 }}>
      <header>
        <div className="eyebrow" style={{ fontSize: 10 }}>{label}</div>
        <p style={{ marginTop: 6, fontSize: 13, color: "var(--fg-2)", maxWidth: 520 }}>{blurb}</p>
      </header>
      <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        {children}
      </div>
    </div>
  );
}

/* ---- A) Plain inline — AI labelled only ---- */
function AiCommentA() {
  return (
    <AiCommentWrap label="[a] // inline" blurb="AI Reviewer is just another participant. Sparkle avatar, [AI] mono tag, otherwise identical to a human comment. Maximum quietness.">
      <div style={{ display: "flex", gap: 12 }}>
        <Avatar ai size="md" />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>AI Reviewer</span>
            <span className="mono" style={{ fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.12em", textTransform: "uppercase", padding: "0 5px", border: "1px solid var(--line)" }}>AI</span>
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>· retry-policy.md · 1h ago</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55 }}>
            Spec is internally consistent. One edge case missing: the <span className="mono" style={{ background: "var(--bg-3)", padding: "0 4px" }}>Retry-After</span> header on 429 — current draft hardcodes <span className="mono">2^n</span> jitter which can violate a server-supplied window. Suggest <span className="mono">backoff = max(2^n + jitter, Retry-After)</span>.
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <Avatar name="ZK" size="md" />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>Zora K.</span>
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>· 42m ago</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55 }}>
            Good catch — adding the clamp to <span className="mono" style={{ background: "var(--bg-3)", padding: "0 4px" }}>retry-wrapper.ts</span>.
          </div>
        </div>
      </div>
    </AiCommentWrap>
  );
}

/* ---- B) Hairline-bordered body block ---- */
function AiCommentB() {
  return (
    <AiCommentWrap label="[b] // hairline-bordered" blurb="Same chrome as a human comment but AI body sits inside a 1px hairline outline. Visual delta is one border, nothing louder.">
      <div style={{ display: "flex", gap: 12 }}>
        <Avatar ai size="md" />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>AI Reviewer</span>
            <span className="mono" style={{ fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.12em", textTransform: "uppercase", padding: "0 5px", border: "1px solid var(--line)" }}>AI</span>
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>· retry-policy.md · 1h ago · sonnet-4-6</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55, border: "1px solid var(--line)", background: "var(--bg-2)", padding: "10px 12px" }}>
            Spec is internally consistent. One edge case missing: the <span className="mono" style={{ background: "var(--bg-3)", padding: "0 4px" }}>Retry-After</span> header on 429 — current draft hardcodes <span className="mono">2^n</span> jitter which can violate a server-supplied window. Suggest <span className="mono">backoff = max(2^n + jitter, Retry-After)</span>.
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 10, fontSize: 11, color: "var(--fg-3)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <Icon name="check" size={11} /> ack
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <Icon name="thumbs-up" size={11} /> helpful
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <Icon name="rotate-cw" size={11} /> re-run
            </span>
          </div>
        </div>
      </div>
    </AiCommentWrap>
  );
}

/* ---- C) Structured findings — header + numbered findings ---- */
function AiCommentC() {
  const findings = [
    { sev: "warn", color: "var(--warn)", title: "Retry-After header not honoured", body: "On 429, current draft uses 2^n jitter only. Clamp to server-supplied window if present." },
    { sev: "info", color: "var(--fg-3)", title: "Jitter bounds not specified",     body: "Tests will be flaky without a max jitter cap. Suggest ±30% deterministic via seed." },
    { sev: "ok",   color: "var(--ok)",   title: "Permanent-fail semantics clear",  body: "Non-429 4xx → status: failed reads as intended." },
  ];
  return (
    <AiCommentWrap label="[c] // structured findings" blurb="Same comment shell, but body is a 3-line summary of findings with severity pips. Trades quietness for scannability — useful for long rubrics.">
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

          {/* summary banner */}
          <div style={{
            fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55,
            paddingBottom: 10, borderBottom: "1px solid var(--line-faint)", marginBottom: 8,
          }}>
            Spec is internally consistent. <span style={{ color: "var(--warn)" }}>1 warning</span>, <span style={{ color: "var(--fg-3)" }}>1 note</span>.
          </div>

          {findings.map((f, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 8, padding: "6px 0", borderTop: i === 0 ? 0 : "1px solid var(--line-faint)" }}>
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
    </AiCommentWrap>
  );
}

Object.assign(window, { AiCommentA, AiCommentB, AiCommentC });
