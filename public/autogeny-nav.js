/* autogeny-nav v1 — injected at build time, do not edit */
(function () {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('autogeny_nav_dismissed')) return;

    var HREF = "http://5.161.200.212:3001/projects/0e2facc7-6a5";

    /* ── Badge container ── */
    var badge = document.createElement('div');
    badge.id = 'autogeny-nav-badge';
    badge.setAttribute('role', 'complementary');
    badge.setAttribute('aria-label', 'Built with Autogeny');
    badge.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'background:#0a0f1a',
      'border:1px solid rgba(34,211,238,0.22)',
      'border-radius:9999px',
      'box-shadow:0 4px 24px rgba(0,0,0,0.65),0 0 0 1px rgba(34,211,238,0.05)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'font-size:12px',
      'line-height:1',
      'opacity:0.92',
      'transition:opacity 0.15s ease,transform 0.15s ease',
      '-webkit-user-select:none',
      'user-select:none',
    ].join(';');

    /* ── Link ── */
    var link = document.createElement('a');
    link.href = HREF;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Back to Autogeny project';
    link.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:6px',
      'padding:7px 10px 7px 11px',
      'text-decoration:none',
      'color:#e2e8f0',
      'border-radius:9999px',
    ].join(';');

    /* ── Clock SVG icon ── */
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#22d3ee');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var circ = document.createElementNS(NS, 'circle');
    circ.setAttribute('cx', '12');
    circ.setAttribute('cy', '12');
    circ.setAttribute('r', '10');
    var hand = document.createElementNS(NS, 'polyline');
    hand.setAttribute('points', '12 6 12 12 16 14');
    svg.appendChild(circ);
    svg.appendChild(hand);

    /* ── Label text ── */
    var span = document.createElement('span');
    span.style.cssText = 'color:#94a3b8;white-space:nowrap;letter-spacing:0.01em';
    span.textContent = 'Built with ';
    var accent = document.createElement('strong');
    accent.style.cssText = 'color:#22d3ee;font-weight:600';
    accent.textContent = 'Autogeny';
    span.appendChild(accent);

    link.appendChild(svg);
    link.appendChild(span);
    badge.appendChild(link);

    /* ── Dismiss (×) button ── */
    var btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Dismiss Autogeny badge');
    btn.style.cssText = [
      '-webkit-appearance:none',
      'appearance:none',
      'background:none',
      'border:none',
      'padding:7px 11px 7px 3px',
      'margin:0',
      'cursor:pointer',
      'color:rgba(148,163,184,0.5)',
      'font-size:13px',
      'line-height:1',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'border-radius:0 9999px 9999px 0',
      'transition:color 0.1s ease',
    ].join(';');
    /* Use textContent — not innerHTML — to avoid innerHTML in CSP-strict environments */
    btn.textContent = '✕';
    btn.onmouseenter = function () { btn.style.color = '#e2e8f0'; };
    btn.onmouseleave = function () { btn.style.color = 'rgba(148,163,184,0.5)'; };
    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      /*
       * Detach hover handlers BEFORE animating out.
       * Without this, badge.onmouseleave fires during the 200ms fade window
       * and resets opacity back to 0.92, causing the badge to visually
       * "un-dismiss" before removeChild runs.
       */
      badge.onmouseenter = null;
      badge.onmouseleave = null;
      try { localStorage.setItem('autogeny_nav_dismissed', '1'); } catch (_) {}
      badge.style.opacity = '0';
      badge.style.transform = 'translateY(6px)';
      setTimeout(function () {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      }, 200);
    };
    badge.appendChild(btn);

    /* ── Hover lift ── */
    badge.onmouseenter = function () {
      badge.style.opacity = '1';
      badge.style.transform = 'translateY(-1px)';
    };
    badge.onmouseleave = function () {
      badge.style.opacity = '0.92';
      badge.style.transform = '';
    };

    /* ── Mount (deferred until body is ready) ── */
    function mount() {
      if (!document.getElementById('autogeny-nav-badge') && document.body) {
        document.body.appendChild(badge);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else {
      mount();
    }
  } catch (_) {
    /* Non-critical — silent fail */
  }
})();
