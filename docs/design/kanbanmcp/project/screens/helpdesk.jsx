/* ============================================================
   KanbanMCP — Helpdesk (ticket list + detail preview)
   ============================================================ */

const TICKETS = [
  { id: "T-2048", subject: "AI Reviewer posted invalid JSON in comment thread", reporter: "harry.k@stripe.com", channel: "email",  status: "open",      priority: "critical", assignee: "JR", labels: ["bug", "ai-review"], age: "12m", unread: true,  promoted: null },
  { id: "T-2047", subject: "Cannot enable AI auto-review on subcards (toggle reverts)", reporter: "milo@anthropic", channel: "slack",  status: "open",   priority: "high", assignee: "ZK", labels: ["bug"], age: "1h",  unread: true,  promoted: null },
  { id: "T-2045", subject: "API key auth fails with 401 after org switch", reporter: "ari.s@vercel", channel: "email",  status: "open",      priority: "high",   assignee: "BC", labels: ["sec", "api"], age: "2h", unread: false, promoted: null },
  { id: "T-2043", subject: "Sub-issue indent collapses after refresh past depth 3", reporter: "ts.miller@bytedance", channel: "web", status: "open",  priority: "medium", assignee: "AB", labels: ["ui"], age: "3h", unread: false, promoted: null },
  { id: "T-2041", subject: "Helpdesk → board promotion appears one-way (intended?)", reporter: "kai.l@figma",       channel: "email", status: "pending",  priority: "low",    assignee: "BC", labels: ["spec"], age: "4h",  unread: false, promoted: "M1-084" },
  { id: "T-2038", subject: "PDF artifact > 10MB silently truncates", reporter: "ada@autogeny.dev",      channel: "internal", status: "open",   priority: "critical", assignee: "JR", labels: ["bug", "ai-review"], age: "6h", unread: false, promoted: "M1-101" },
  { id: "T-2036", subject: "Trial: how do I set per-sprint rubric defaults?", reporter: "wren.l@neon",   channel: "email", status: "waiting",  priority: "low",    assignee: "BC", labels: ["question"], age: "1d", unread: false, promoted: null },
  { id: "T-2031", subject: "Daily digest sent at 5am UTC — can this be timezone-local?", reporter: "ru.h@plaid", channel: "web", status: "open",  priority: "medium", assignee: "AB", labels: ["feature"], age: "1d", unread: false, promoted: null },
  { id: "T-2028", subject: "Webhook for review.completed missing on rejected", reporter: "ines@retool",   channel: "email", status: "open",     priority: "high",   assignee: "ZK", labels: ["bug", "webhook"], age: "2d", unread: false, promoted: null },
  { id: "T-2024", subject: "Drag-drop occasionally drops card into wrong column",  reporter: "ben.t@linear",  channel: "slack",  status: "pending",  priority: "medium", assignee: "BC", labels: ["bug", "ui"], age: "2d", unread: false, promoted: null },
  { id: "T-2019", subject: "Cycle detection error on legitimate reparent",         reporter: "fjord@modal",  channel: "email", status: "closed",   priority: "high",  assignee: "JR", labels: ["bug"], age: "3d", unread: false, promoted: "M1-097" },
];

const CHANNEL_GLYPH = { email: "@", slack: "#", web: "~", internal: "*" };

const STATUS_TONE = {
  open: { color: "var(--accent)", border: "var(--accent)" },
  pending: { color: "var(--warn)", border: "var(--warn)" },
  waiting: { color: "var(--fg-2)", border: "var(--line-strong)" },
  closed: { color: "var(--fg-3)", border: "var(--line)" },
};
const PRIO_COLOR = {
  critical: "var(--p-critical)",
  high: "var(--p-high)",
  medium: "var(--p-medium)",
  low: "var(--p-low)",
};

function TicketRow({ t, active }) {
  const status = STATUS_TONE[t.status];
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "10px 70px 70px 1fr 110px 70px 90px",
      alignItems: "center", gap: 12,
      padding: "10px 16px",
      borderTop: "1px solid var(--line-faint)",
      background: active ? "var(--bg-2)" : "transparent",
      borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
      cursor: "pointer",
      position: "relative",
    }}>
      {/* unread pip */}
      <span className={t.unread ? "pip pip--accent" : "pip"} style={{ visibility: t.unread ? "visible" : "hidden" }} />

      <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.06em" }}>{t.id}</span>

      <span style={{
        fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase",
        padding: "2px 7px", border: `1px solid ${status.border}`, color: status.color, textAlign: "center", width: "fit-content"
      }}>
        {t.status}
      </span>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 3, height: 12, background: PRIO_COLOR[t.priority] || "transparent" }} />
          <span style={{
            fontSize: 13, color: t.unread ? "var(--fg-0)" : "var(--fg-1)", fontWeight: t.unread ? 500 : 400,
            letterSpacing: "-0.005em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
          }}>{t.subject}</span>
        </div>
        <div className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 2, display: "flex", gap: 8 }}>
          <span><span style={{ color: "var(--fg-2)" }}>{CHANNEL_GLYPH[t.channel]}</span> {t.reporter}</span>
          {t.labels.map(l =>
            <span key={l} style={{ color: "var(--fg-3)" }}>#{l}</span>
          )}
          {t.promoted && (
            <span style={{ color: "var(--accent)" }}>→ {t.promoted}</span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-start" }}>
        <Avatar name={t.assignee} size="sm" />
        <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{t.assignee}</span>
      </div>

      <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", textAlign: "right", letterSpacing: "0.06em" }}>
        {t.age}
      </span>

      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {!t.promoted && t.status !== "closed" && (
          <button className="btn btn--sm" style={{ fontSize: 10, letterSpacing: "0.04em" }}>
            promote →
          </button>
        )}
      </div>
    </div>
  );
}

function HelpdeskScreen() {
  const counts = {
    all: TICKETS.length,
    open: TICKETS.filter(t => t.status === "open").length,
    pending: TICKETS.filter(t => t.status === "pending").length,
    closed: TICKETS.filter(t => t.status === "closed").length,
  };

  return (
    <div data-screen-label="04 Helpdesk" style={{
      width: 1440, height: 900,
      display: "flex", overflow: "hidden",
      background: "var(--bg-0)",
      fontFamily: "var(--font-body)",
      color: "var(--fg-1)",
    }}>
      <Sidebar active="helpdesk" boardId="" />

      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Topbar
          breadcrumb="org / helpdesk"
          title="helpdesk"
          mode="helpdesk"
          right={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.06em" }}>
                avg first-response · <span style={{ color: "var(--fg-1)" }}>14m</span> · sla <span style={{ color: "var(--ok)" }}>● ok</span>
              </span>
              <div style={{ width: 1, height: 20, background: "var(--line)" }} />
              <button className="btn"><Icon name="filter" size={13}/> filter</button>
              <button className="btn"><Icon name="settings-2" size={13}/> rules</button>
              <button className="btn btn--primary"><Icon name="plus" size={13} color="#fff"/> new ticket</button>
            </div>
          }
        />

        {/* Tabs / status filter */}
        <div style={{
          height: 44,
          borderBottom: "1px solid var(--line)",
          background: "var(--bg-1)",
          padding: "0 24px",
          display: "flex", alignItems: "center", gap: 0,
          flexShrink: 0,
        }}>
          {[
            { id: "all",     label: "all",     n: counts.all,     tone: null },
            { id: "open",    label: "open",    n: counts.open,    tone: "accent" , active: true },
            { id: "pending", label: "pending", n: counts.pending, tone: "warn"},
            { id: "waiting", label: "waiting", n: 1,              tone: null },
            { id: "closed",  label: "closed",  n: counts.closed,  tone: null },
            { id: "promoted",label: "promoted",n: 3,              tone: null },
          ].map(t => (
            <div key={t.id} style={{
              padding: "0 14px",
              height: "100%",
              display: "flex", alignItems: "center", gap: 8,
              cursor: "pointer",
              borderBottom: t.active ? "2px solid var(--accent)" : "2px solid transparent",
              color: t.active ? "var(--fg-0)" : "var(--fg-2)",
            }}>
              <span style={{ fontSize: 13, fontWeight: t.active ? 500 : 400, letterSpacing: "-0.005em" }}>{t.label}</span>
              <span className="mono" style={{
                fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase",
                padding: "1px 5px", border: `1px solid var(--line)`,
                color: t.tone === "accent" ? "var(--accent)" : t.tone === "warn" ? "var(--warn)" : "var(--fg-3)",
                borderColor: t.tone === "accent" ? "var(--accent)" : t.tone === "warn" ? "var(--warn)" : "var(--line)",
              }}>{String(t.n).padStart(2, "0")}</span>
            </div>
          ))}

          <div style={{ flex: 1 }} />

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              height: 28, display: "flex", alignItems: "center", gap: 6,
              border: "1px solid var(--line)",
              background: "var(--bg-2)",
              padding: "0 8px",
            }}>
              <Icon name="search" size={11} color="var(--fg-3)" />
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>search tickets…</span>
            </div>
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em" }}>sort · age ↓</span>
          </div>
        </div>

        {/* Body — list + preview */}
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 420px", minHeight: 0 }}>
          {/* TICKETS LIST */}
          <div style={{ overflow: "auto", borderRight: "1px solid var(--line)", background: "var(--bg-1)" }}>
            {/* table header */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "10px 70px 70px 1fr 110px 70px 90px",
              alignItems: "center", gap: 12,
              padding: "8px 16px",
              borderBottom: "1px solid var(--line)",
              background: "var(--bg-2)",
              position: "sticky", top: 0, zIndex: 1,
            }}>
              <span />
              <span className="eyebrow" style={{ fontSize: 9 }}>id</span>
              <span className="eyebrow" style={{ fontSize: 9 }}>state</span>
              <span className="eyebrow" style={{ fontSize: 9 }}>subject · reporter</span>
              <span className="eyebrow" style={{ fontSize: 9 }}>owner</span>
              <span className="eyebrow" style={{ fontSize: 9, textAlign: "right" }}>age</span>
              <span />
            </div>

            {TICKETS.map((t, i) => <TicketRow key={t.id} t={t} active={i === 0} />)}
          </div>

          {/* DETAIL PREVIEW */}
          <aside style={{ overflow: "auto", background: "var(--bg-1)" }}>
            <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.06em" }}>T-2048</span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase",
                  padding: "2px 7px", border: `1px solid var(--accent)`, color: "var(--accent)"
                }}>open</span>
                <span style={{ width: 3, height: 12, background: "var(--p-critical)", display: "inline-block" }} />
                <span className="mono" style={{ fontSize: 10, color: "var(--p-critical)", letterSpacing: "0.1em", textTransform: "uppercase" }}>critical</span>
              </div>
              <h2 style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.015em", color: "var(--fg-0)", lineHeight: 1.3 }}>
                AI Reviewer posted invalid JSON in comment thread
              </h2>
              <div className="mono" style={{ marginTop: 8, fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                @ harry.k@stripe.com · via email · 12m ago
              </div>
            </div>

            {/* Quick actions */}
            <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--line)", display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="btn btn--sm btn--primary"><Icon name="git-pull-request-arrow" size={11} color="#fff"/> promote to board</button>
              <button className="btn btn--sm"><Icon name="user-plus" size={11}/> reassign</button>
              <button className="btn btn--sm"><Icon name="archive" size={11}/> close</button>
              <button className="btn btn--sm"><Icon name="sparkles" size={11} color="var(--accent)"/> draft reply</button>
            </div>

            {/* Body excerpt */}
            <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)" }}>
              <div className="eyebrow" style={{ fontSize: 9, marginBottom: 8 }}>/// original message</div>
              <p style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.6 }}>
                Hi — we just enabled AI auto-review on our spec PDFs. About 1 in 4 reviews come back with the assistant returning malformed JSON (unescaped quotes) which then breaks the comment formatter on our side. Easy repro on the attached PDF.
              </p>
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--line)", background: "var(--bg-2)" }}>
                <Icon name="paperclip" size={13} color="var(--fg-3)" />
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-1)", flex: 1 }}>repro-spec-v3.pdf</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>1.4 MB</span>
              </div>
            </div>

            {/* Meta */}
            <div>
              <MetaRow label="assignee">
                <Avatar name="JR" size="sm" /><span>Jules Reyes</span>
              </MetaRow>
              <MetaRow label="reporter">
                <Avatar name="HK" size="sm" color="#4D7CFF" /><span className="mono" style={{ fontSize: 11 }}>harry.k@stripe.com</span>
              </MetaRow>
              <MetaRow label="channel">
                <span className="mono" style={{ fontSize: 11 }}>@ email · zendesk-sync</span>
              </MetaRow>
              <MetaRow label="labels">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 8px", border: "1px solid var(--line)", fontSize: 11 }}>
                  <span style={{ width: 6, height: 6, background: "#D11629" }} /> bug
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 8px", border: "1px solid var(--line)", fontSize: 11 }}>
                  <span style={{ width: 6, height: 6, background: "#2A6FDB" }} /> ai-review
                </span>
              </MetaRow>
              <MetaRow label="sla">
                <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>respond &lt; 1h</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>· 48m remaining</span>
              </MetaRow>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { HelpdeskScreen, TICKETS });
