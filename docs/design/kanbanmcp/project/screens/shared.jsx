/* ============================================================
   KanbanMCP — shared components used across screens
   ============================================================ */

// Brand mark — square outline with "k" ligature + accent stamp.
// Inherits Autogeny's mark conventions (1px box, corner ticks, accent stamp).
function BrandMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" style={{ flexShrink: 0 }}>
      <rect x="0.5" y="0.5" width="63" height="63" stroke="currentColor" strokeWidth="1" fill="none" />
      <path d="M0 8 L4 8 M0 56 L4 56 M60 8 L64 8 M60 56 L64 56 M8 0 L8 4 M56 0 L56 4 M8 60 L8 64 M56 60 L56 64"
            stroke="currentColor" strokeWidth="1" />
      {/* three-bar kanban glyph */}
      <rect x="14" y="18" width="8" height="28" fill="currentColor" />
      <rect x="28" y="18" width="8" height="18" fill="currentColor" />
      <rect x="42" y="18" width="8" height="34" fill="#E11D2B" />
      <rect x="49" y="49" width="6" height="6" fill="#E11D2B" />
    </svg>
  );
}

function Wordmark({ size = 16 }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <BrandMark size={size + 8} />
      <span style={{
        fontFamily: "var(--font-display)",
        fontWeight: 600,
        fontSize: size,
        letterSpacing: "-0.01em",
        color: "var(--fg-0)",
      }}>
        kanban<span style={{ color: "var(--accent)" }}>·</span>mcp
      </span>
    </div>
  );
}

/* ---- Lucide icon helper ---- */
function Icon({ name, size = 14, stroke = 1.5, style = {}, color }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (window.lucide && ref.current) {
      ref.current.innerHTML = "";
      const i = document.createElement("i");
      i.setAttribute("data-lucide", name);
      ref.current.appendChild(i);
      window.lucide.createIcons({
        attrs: { width: size, height: size, "stroke-width": stroke },
      });
    }
  }, [name, size, stroke]);
  return (
    <span
      ref={ref}
      style={{
        display: "inline-flex",
        width: size, height: size,
        color: color || "currentColor",
        ...style,
      }}
    />
  );
}

/* ---- Avatar with initials ---- */
function Avatar({ name, size = "md", color, ai = false }) {
  const cls = size === "sm" ? "avatar avatar--sm" : size === "lg" ? "avatar avatar--lg" : "avatar";
  const initials = (name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const style = color ? { background: color } : {};
  if (ai) return (
    <span className={`${cls} avatar--ai`} title="AI Reviewer" style={style}>
      <Icon name="sparkles" size={size === "lg" ? 14 : size === "sm" ? 9 : 11} color="#fff" stroke={1.75} />
    </span>
  );
  return <span className={cls} style={style}>{initials}</span>;
}

/* ---- Chip ---- */
function Chip({ tone, children, dot, solid }) {
  const cls =
    `chip ${tone === "ok" ? "chip--ok" : tone === "warn" ? "chip--warn" :
      tone === "err" ? "chip--err" : tone === "accent" ? "chip--accent" :
      tone === "accent-solid" ? "chip--solid-accent" : ""}`;
  return (
    <span className={cls}>
      {dot && <span className={`pip pip--${tone || "accent"}`} />}
      {children}
    </span>
  );
}

/* ---- Priority indicator (the canonical version — bar at left of card)  ---- */
function PriorityBar({ level }) {
  if (!level || level === "none") return null;
  const colors = {
    critical: "var(--p-critical)",
    high: "var(--p-high)",
    medium: "var(--p-medium)",
    low: "var(--p-low)",
  };
  return (
    <span title={`Priority: ${level}`} style={{
      display: "inline-block",
      width: 3, height: 12,
      background: colors[level],
    }} />
  );
}

/* ---- Sidebar ---- */
function Sidebar({ active = "board", board = "core/m1", boardId = "core" }) {
  const nav = [
    { id: "dashboard",  label: "dashboard",  icon: "layout-dashboard" },
    { id: "inbox",      label: "inbox",      icon: "inbox",            badge: "3" },
  ];
  const boards = [
    { id: "core",      name: "core / m1 — review workflow", count: 28, active: true },
    { id: "agents",    name: "agents / runtime",            count: 14 },
    { id: "infra",     name: "infra / migrations",          count:  7 },
    { id: "design",    name: "design / brand-2026",         count: 11 },
  ];
  const manage = [
    { id: "helpdesk", label: "helpdesk", icon: "life-buoy",  badge: "12" },
    { id: "activity", label: "activity", icon: "activity" },
    { id: "agents",   label: "agents",   icon: "bot",       badge: { tone: "accent", text: "•" } },
    { id: "settings", label: "settings", icon: "settings-2" },
  ];

  const itemStyle = (isActive) => ({
    display: "flex", alignItems: "center", gap: 10,
    padding: "6px 14px 6px 14px",
    fontSize: 13,
    color: isActive ? "var(--fg-0)" : "var(--fg-2)",
    background: isActive ? "var(--bg-2)" : "transparent",
    borderLeft: `2px solid ${isActive ? "var(--accent)" : "transparent"}`,
    cursor: "pointer",
    letterSpacing: "-0.005em",
  });

  return (
    <aside style={{
      width: 240,
      background: "var(--bg-1)",
      borderRight: "1px solid var(--line)",
      display: "flex", flexDirection: "column",
      flexShrink: 0,
    }}>
      {/* Brand */}
      <div style={{ padding: "16px 16px 14px", borderBottom: "1px solid var(--line)" }}>
        <Wordmark size={15} />
        <div className="eyebrow" style={{ marginTop: 8, fontSize: 9, color: "var(--fg-3)" }}>
          org / autogeny &nbsp;·&nbsp; <span style={{ color: "var(--ok)" }}>● connected</span>
        </div>
      </div>

      {/* Top nav */}
      <div style={{ padding: "10px 0 6px" }}>
        {nav.map(n => (
          <div key={n.id} style={itemStyle(active === n.id)}>
            <Icon name={n.icon} size={14} />
            <span style={{ flex: 1 }}>{n.label}</span>
            {n.badge && <span className="mono" style={{ fontSize: 10, color: "var(--accent)" }}>[{n.badge}]</span>}
          </div>
        ))}
      </div>

      {/* Boards */}
      <div style={{ padding: "10px 16px 6px" }}>
        <div className="eyebrow" style={{ fontSize: 9, color: "var(--fg-3)" }}>
          [01] // boards
        </div>
      </div>
      <div style={{ paddingBottom: 6 }}>
        {boards.map(b => (
          <div key={b.id} style={itemStyle(b.id === boardId)}>
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", width: 14 }}>
              {b.id === boardId ? "▸" : "·"}
            </span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.name}
            </span>
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{b.count}</span>
          </div>
        ))}
      </div>

      {/* Manage */}
      <div style={{ padding: "16px 16px 6px" }}>
        <div className="eyebrow" style={{ fontSize: 9, color: "var(--fg-3)" }}>
          [02] // manage
        </div>
      </div>
      <div>
        {manage.map(m => (
          <div key={m.id} style={itemStyle(active === m.id)}>
            <Icon name={m.icon} size={14} />
            <span style={{ flex: 1 }}>{m.label}</span>
            {m.badge && typeof m.badge === "string" && (
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>[{m.badge}]</span>
            )}
            {m.badge && typeof m.badge === "object" && (
              <span className="pip pip--accent" />
            )}
          </div>
        ))}
      </div>

      {/* MCP status block */}
      <div style={{ marginTop: "auto", padding: 16, borderTop: "1px solid var(--line)", background: "var(--bg-2)" }}>
        <div className="eyebrow" style={{ fontSize: 9, color: "var(--fg-3)", marginBottom: 6 }}>
          mcp endpoint
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-1)", lineHeight: 1.4 }}>
          /api/mcp
        </div>
        <div className="mono" style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 4 }}>
          11 tools · <span style={{ color: "var(--ok)" }}>● live</span>
        </div>
        <div className="hr" style={{ margin: "10px 0" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Avatar name="Beth Cunningham" size="sm" />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, color: "var(--fg-1)", letterSpacing: "-0.005em" }}>beth c.</div>
            <div className="mono" style={{ fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.06em" }}>OWNER</div>
          </div>
          <Icon name="log-out" size={13} color="var(--fg-3)" />
        </div>
      </div>
    </aside>
  );
}

/* ---- Topbar (board page header) ---- */
function Topbar({ title, breadcrumb, right, mode = "board" }) {
  return (
    <header style={{
      height: 56,
      borderBottom: "1px solid var(--line)",
      background: "var(--bg-1)",
      display: "flex", alignItems: "center",
      padding: "0 24px",
      gap: 16,
      flexShrink: 0,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {breadcrumb && (
          <div className="mono" style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-3)", textTransform: "uppercase", marginBottom: 2 }}>
            {breadcrumb}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{
            fontSize: 18, fontWeight: 600, color: "var(--fg-0)",
            letterSpacing: "-0.01em",
          }}>{title}</h1>
          {mode === "board" && <span className="chip">{/* board status */}<span className="pip pip--ok" />active sprint · s11</span>}
        </div>
      </div>
      {right}
    </header>
  );
}

/* ---- Small mono key-value block ---- */
function KV({ label, children, mono = true }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="eyebrow" style={{ fontSize: 9, color: "var(--fg-3)" }}>{label}</div>
      <div style={{ fontSize: 12, color: "var(--fg-1)", fontFamily: mono ? "var(--font-mono)" : "var(--font-body)" }}>
        {children}
      </div>
    </div>
  );
}

/* expose globally for other babel files */
Object.assign(window, { BrandMark, Wordmark, Icon, Avatar, Chip, PriorityBar, Sidebar, Topbar, KV });
