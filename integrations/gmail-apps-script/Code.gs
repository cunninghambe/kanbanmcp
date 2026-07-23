/**
 * mhud INBOX AGENT — Gmail triage → Claude → mhud (KanbanMCP)
 * =============================================================
 * Runs entirely inside Google Apps Script. No app password, no server.
 *
 * Loop (every 30 min):
 *   1. Pull unprocessed inbox threads
 *   2. Hard rules first (2FA, DocuSign, VIP senders → URGENT passthrough)
 *   3. Claude classifies the rest: URGENT / ACTIONABLE / NEEDS_REPLY / FYI / NOISE
 *   4. URGENT + ACTIONABLE + NEEDS_REPLY → cards on the mhud board via the
 *      create_card MCP tool. URGENT also raises a create_nudge (the mhud
 *      banner) + optional ntfy push.
 *   5. FYI + NOISE → labeled, archived, rolled into one daily digest/audit card
 *
 * Web app (doPost) actions, called from mhud's /api/inbox-agent proxy
 * (human-session only — the send path never fires from the script itself):
 *   draft : voice-note text + threadId → Claude writes reply → Gmail draft
 *   send  : draftId → sends the approved draft
 *   ack   : threadId → clears the urgent flag
 *
 * Both mhud tool calls (create_card, create_nudge) go through the JSON-RPC
 * `/api/mcp` endpoint using ONE write-scoped ApiKey and ONE envelope/error
 * helper: kanbanRpc_(). JSON-RPC failures return HTTP 200 with a body.error
 * field — kanbanRpc_() throws on those so a failed create never lets the
 * triage loop archive (and thereby lose) the source email.
 *
 * SETUP: see SETUP.md. Run setup() once after filling Script Properties.
 */

// ---------------------------------------------------------------------------
// CONFIG — everything lives in Script Properties (File > Project Settings)
// ---------------------------------------------------------------------------
function cfg_() {
  const p = PropertiesService.getScriptProperties();
  const req = (k) => {
    const v = p.getProperty(k);
    if (!v) throw new Error('Missing Script Property: ' + k);
    return v;
  };
  return {
    ANTHROPIC_API_KEY: req('ANTHROPIC_API_KEY'),
    CLASSIFY_MODEL: p.getProperty('CLASSIFY_MODEL') || 'claude-haiku-4-5-20251001',
    DRAFT_MODEL: p.getProperty('DRAFT_MODEL') || 'claude-sonnet-4-6',

    // mhud (KanbanMCP) — JSON-RPC tools/call against /api/mcp. The key MUST
    // be a write-scoped ApiKey (permissions: ["write"]) — create_card and
    // create_nudge are both WRITE_TOOLS server-side. Do not reuse the HUD
    // dispatch key (["read","propose"]); it cannot create anything here.
    KANBAN_MCP_URL: req('KANBAN_MCP_URL'),          // e.g. https://mhud.yourhost.com/api/mcp
    KANBAN_API_KEY: req('KANBAN_API_KEY'),
    KANBAN_BOARD_ID: req('KANBAN_BOARD_ID'),
    COL_URGENT: req('COL_URGENT'),                  // column IDs on the board
    COL_TRIAGE: req('COL_TRIAGE'),
    COL_DIGEST: req('COL_DIGEST'),

    // Optional: enables the daily inbox-expire cron call (see expireTriage()).
    // Skipped silently when unset.
    KANBAN_CRON_SECRET: p.getProperty('KANBAN_CRON_SECRET') || '',

    NTFY_TOPIC: p.getProperty('NTFY_TOPIC') || '',                // optional phone push

    // Shared secret your kanban UI sends to doPost
    WEBHOOK_TOKEN: req('WEBHOOK_TOKEN'),

    // Comma-separated. Senders/domains that always go URGENT, no LLM involved.
    VIP_SENDERS: (p.getProperty('VIP_SENDERS') || '').toLowerCase(),
    // Style notes injected into every reply draft.
    VOICE_NOTES: p.getProperty('VOICE_NOTES') ||
      'Direct, warm, concise. No corporate filler. Never use em-dashes. Sign off: Brad',

    BATCH_SIZE: Number(p.getProperty('BATCH_SIZE') || 15),
    BODY_CHARS: Number(p.getProperty('BODY_CHARS') || 1500),
  };
}

const LABELS = {
  processed: 'ai/processed',
  urgent: 'ai/urgent',
  actionable: 'ai/actionable',
  needsReply: 'ai/needs-reply',
  fyi: 'ai/fyi',
  noise: 'ai/noise',
  acked: 'ai/acked',
};

// ---------------------------------------------------------------------------
// ONE-TIME SETUP — creates labels and installs triggers
// ---------------------------------------------------------------------------
function setup() {
  Object.values(LABELS).forEach((n) => GmailApp.getUserLabelByName(n) || GmailApp.createLabel(n));
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('triage').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(7).nearMinute(30).everyDays(1).create();
  ScriptApp.newTrigger('expireTriage').timeBased().atHour(6).everyDays(1).create();
  Logger.log('Labels created, triggers installed. Fill Script Properties, then run triage() once manually to authorize scopes.');
}

// ---------------------------------------------------------------------------
// MAIN TRIAGE LOOP
// ---------------------------------------------------------------------------
function triage() {
  const c = cfg_();
  const threads = GmailApp.search('in:inbox -label:' + LABELS.processed, 0, c.BATCH_SIZE);
  if (!threads.length) return;

  const metas = threads.map(threadMeta_);

  // Pass 1: hard rules. These never wait on, or trust, the LLM.
  const toClassify = [];
  metas.forEach((m) => {
    const rule = hardRule_(m, c);
    if (rule === 'URGENT') {
      m.bucket = 'URGENT';
      m.summary = m.subject;
      m.reason = 'hard rule (VIP / 2FA / signature request)';
    } else {
      toClassify.push(m);
    }
  });

  // Pass 2: Claude classifies the remainder in one batch call.
  if (toClassify.length) {
    let results = {};
    try {
      results = classifyBatch_(toClassify, c);
    } catch (err) {
      // Fail SAFE: classifier down → everything becomes an ACTIONABLE card.
      // You never silently lose mail to an outage.
      Logger.log('Classifier failed, failing safe to ACTIONABLE: ' + err);
    }
    toClassify.forEach((m) => {
      const r = results[m.id] || {};
      m.bucket = r.bucket || 'ACTIONABLE';
      m.summary = r.summary || m.subject;
      m.deadline = r.deadline || null;
      m.action = r.suggested_action || '';
    });
  }

  // Pass 3: act on buckets.
  metas.forEach((m) => {
    try {
      dispatch_(m, c);
    } catch (err) {
      Logger.log('Dispatch failed for thread ' + m.id + ': ' + err);
      // Leave unlabeled so the next run retries it.
      return;
    }
    m.thread.addLabel(label_(LABELS.processed));
  });
}

// Priority mapping (correction 1): mhud's create_card only accepts
// none|low|medium|high|critical — 'urgent'/'normal' are rejected with -32602.
function dispatch_(m, c) {
  switch (m.bucket) {
    case 'URGENT': {
      m.thread.addLabel(label_(LABELS.urgent));
      const cardId = kanbanCreateCard_(c, c.COL_URGENT, '🔴 ' + m.summary, cardBody_(m), 'critical', m.deadline);
      fireNudge_(c, m, cardId);
      break; // stays in inbox on purpose
    }
    case 'ACTIONABLE':
      m.thread.addLabel(label_(LABELS.actionable));
      kanbanCreateCard_(c, c.COL_TRIAGE, m.summary, cardBody_(m), 'medium', m.deadline);
      m.thread.moveToArchive();
      break;
    case 'NEEDS_REPLY':
      m.thread.addLabel(label_(LABELS.needsReply));
      kanbanCreateCard_(c, c.COL_TRIAGE, '✉️ ' + m.summary, cardBody_(m) +
        '\n\n**Reply flow:** voice note on this card → agent drafts → you approve.', 'medium', m.deadline);
      m.thread.moveToArchive();
      break;
    case 'FYI':
      m.thread.addLabel(label_(LABELS.fyi));
      m.thread.moveToArchive();
      break;
    default: // NOISE
      m.thread.addLabel(label_(LABELS.noise));
      m.thread.moveToArchive();
  }
}

// ---------------------------------------------------------------------------
// HARD RULES — pattern matching, zero LLM latency, zero LLM trust
// ---------------------------------------------------------------------------
function hardRule_(m, c) {
  const from = m.from.toLowerCase();
  if (c.VIP_SENDERS && c.VIP_SENDERS.split(',').some((s) => s.trim() && from.indexOf(s.trim()) !== -1)) {
    return 'URGENT';
  }
  const s = (m.subject + ' ' + m.snippet).toLowerCase();
  if (/verification code|security code|one.time (pass|code)|\b2fa\b|sign.in attempt/.test(s)) return 'URGENT';
  if (/docusign|signature request|action required: sign|sign the document/.test(s)) return 'URGENT';
  return null;
}

// ---------------------------------------------------------------------------
// CLASSIFIER
// ---------------------------------------------------------------------------
function classifyBatch_(metas, c) {
  const emails = metas.map((m) => ({
    id: m.id, from: m.from, subject: m.subject, date: m.date, body: m.body,
  }));
  const system =
    'You triage email for a COO who is job searching and winding down a company. ' +
    'Classify each email. Buckets: ' +
    'URGENT (time-critical today: interview scheduling, recruiter replies, deadlines, legal/financial action, anything from Bangladesh/Nigeria program handover contacts that blocks people), ' +
    'ACTIONABLE (needs his action but not today), ' +
    'NEEDS_REPLY (a human wrote to him personally and expects a response), ' +
    'FYI (informational, no action), ' +
    'NOISE (newsletters, marketing, automated notifications with no action). ' +
    'When genuinely unsure between two buckets, pick the more attention-getting one. ' +
    'Respond with ONLY a JSON array, no markdown fences. Each element: ' +
    '{"id": string, "bucket": string, "summary": string (max 12 words, imperative where possible), ' +
    '"deadline": string|null (ISO date if one is stated or strongly implied), ' +
    '"suggested_action": string (one short sentence)}';
  const text = claude_(c, c.CLASSIFY_MODEL, system, JSON.stringify(emails), 2000);
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  const byId = {};
  parsed.forEach((r) => (byId[r.id] = r));
  return byId;
}

// ---------------------------------------------------------------------------
// DAILY DIGEST + AUDIT — one card, everything the agent handled for you
// ---------------------------------------------------------------------------
function dailyDigest() {
  const c = cfg_();
  const section = (labelName, title) => {
    const threads = GmailApp.search('label:' + labelName + ' newer_than:1d');
    if (!threads.length) return '';
    return '\n**' + title + ' (' + threads.length + ')**\n' + threads.map((t) =>
      '- ' + t.getFirstMessageSubject() + ' · ' + senderOf_(t) + ' · [open](' + t.getPermalink() + ')'
    ).join('\n') + '\n';
  };
  const body =
    'Everything triaged away from you in the last 24h. Scan this for the first month; ' +
    'anything misfiled, tell the agent and add the sender to VIP or adjust the prompt.\n' +
    section(LABELS.fyi, 'FYI') +
    section(LABELS.noise, 'Archived as noise');
  kanbanCreateCard_(c, c.COL_DIGEST, '📥 Inbox digest · ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEE d MMM'), body, 'low');
}

// ---------------------------------------------------------------------------
// WEB APP — the approve loop your kanban UI calls
// ---------------------------------------------------------------------------
function doPost(e) {
  const c = cfg_();
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (_) { return json_({ error: 'bad json' }); }
  if (req.token !== c.WEBHOOK_TOKEN) return json_({ error: 'unauthorized' });

  try {
    if (req.action === 'draft')  return json_(draftReply_(c, req.threadId, req.instructions, !!req.replyAll));
    if (req.action === 'send')   return json_(sendDraft_(req.draftId));
    if (req.action === 'ack')    return json_(ackUrgent_(req.threadId));
    return json_({ error: 'unknown action' });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

/** Voice-note text in, Gmail draft out. Returns preview for the card UI. */
function draftReply_(c, threadId, instructions, replyAll) {
  const thread = GmailApp.getThreadById(threadId);
  if (!thread) throw new Error('thread not found: ' + threadId);
  const msgs = thread.getMessages();
  const context = msgs.slice(-4).map((m) =>
    'From: ' + m.getFrom() + '\nDate: ' + m.getDate() + '\n' +
    m.getPlainBody().slice(0, 2500)
  ).join('\n---\n');

  const system =
    'You draft email replies as Brad. Style: ' + c.VOICE_NOTES + ' ' +
    'You receive the thread and Brad\'s voice-note instructions describing what to say. ' +
    'Write the reply body only. No subject line, no commentary, no placeholders like [Name]. ' +
    'Say only what the instructions authorize; do not invent commitments, dates, or numbers.';
  const body = claude_(c, c.DRAFT_MODEL, system,
    'THREAD:\n' + context + '\n\nBRAD\'S INSTRUCTIONS:\n' + instructions, 1200);

  const last = msgs[msgs.length - 1];
  const draft = replyAll ? last.createDraftReplyAll(body) : last.createDraftReply(body);
  return { draftId: draft.getId(), preview: body, to: last.getFrom() };
}

function sendDraft_(draftId) {
  const draft = GmailApp.getDraft(draftId);
  if (!draft) throw new Error('draft not found (already sent?): ' + draftId);
  const msg = draft.send();
  return { sent: true, messageId: msg.getId() };
}

function ackUrgent_(threadId) {
  const thread = GmailApp.getThreadById(threadId);
  if (!thread) throw new Error('thread not found: ' + threadId);
  thread.removeLabel(label_(LABELS.urgent));
  thread.addLabel(label_(LABELS.acked));
  return { acked: true };
}

// ---------------------------------------------------------------------------
// KANBAN ADAPTER — the ONE place that knows mhud's tool schema
// ---------------------------------------------------------------------------
/**
 * Shared JSON-RPC envelope + error handling for every mhud /api/mcp call.
 * IMPORTANT: /api/mcp returns JSON-RPC failures as HTTP 200 with a
 * body.error field (correction 3) — an HTTP-status-only check would let a
 * failed create_card silently archive the source email. This throws on
 * body.error so the caller leaves the thread unprocessed for retry.
 */
function kanbanRpc_(c, tool, args) {
  const payload = {
    jsonrpc: '2.0',
    id: Utilities.getUuid(),
    method: 'tools/call',
    params: { name: tool, arguments: args },
  };
  const res = UrlFetchApp.fetch(c.KANBAN_MCP_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + c.KANBAN_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('mhud ' + tool + ' HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const body = JSON.parse(res.getContentText());
  if (body && body.error) {
    throw new Error('mhud ' + tool + ' RPC error: ' + JSON.stringify(body.error).slice(0, 300));
  }
  return body.result;
}

/**
 * create_card args per mhud's mcp-server.ts: { boardId, columnId, title,
 * description?, dueDate?, sprintId?, priority? }. priority must be one of
 * none|low|medium|high|critical (see dispatch_() for the bucket mapping).
 * deadline is only forwarded as dueDate when it parses as a real date
 * (correction 2) — a garbage/unparseable string must not reach the API.
 */
function kanbanCreateCard_(c, columnId, title, description, priority, deadline) {
  const args = {
    boardId: c.KANBAN_BOARD_ID,
    columnId: columnId,
    title: title.slice(0, 200),
    description: description,
    priority: priority,
  };
  if (deadline) {
    const d = new Date(deadline);
    if (!isNaN(d.getTime())) args.dueDate = d.toISOString();
  }
  const result = kanbanRpc_(c, 'create_card', args);
  return result && result.id ? result.id : null; // result.id, NOT result.cardId (correction 4)
}

function cardBody_(m) {
  return [
    m.summary !== m.subject ? '**' + m.subject + '**' : '',
    'From: ' + m.from,
    m.deadline ? '⏰ Deadline: ' + m.deadline : '',
    m.action ? 'Suggested: ' + m.action : '',
    '',
    '[Open in Gmail](' + m.permalink + ')',
    '',
    '`gmail:' + m.id + '`', // machine-readable hook for the draft/send/ack webhook
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// NUDGE — mhud banner via the create_nudge MCP tool, optional phone push
// (correction 5: replaces the old NUDGE_WEBHOOK_URL/NUDGE_SECRET ad-hoc
// webhook + in-memory Map with a first-class tool over the same /api/mcp
// endpoint and ApiKey — one endpoint, one credential, org-scoped, survives
// restarts. create_nudge is idempotent per gmailThreadId server-side, so
// reruns of triage() never stack duplicate banners.)
// ---------------------------------------------------------------------------
function fireNudge_(c, m, cardId) {
  try {
    kanbanRpc_(c, 'create_nudge', {
      title: m.from.replace(/<.*>/, '').trim() + ': ' + m.summary,
      summary: m.summary,
      fromLabel: m.from.replace(/<.*>/, '').trim(),
      gmailThreadId: m.id,
      permalink: m.permalink,
      cardId: cardId,
    });
  } catch (err) { Logger.log('create_nudge failed: ' + err); }

  if (c.NTFY_TOPIC) {
    try {
      UrlFetchApp.fetch('https://ntfy.sh/' + c.NTFY_TOPIC, {
        method: 'post',
        headers: { Title: 'Urgent: ' + m.from, Priority: 'high', Click: m.permalink },
        payload: m.summary,
        muteHttpExceptions: true,
      });
    } catch (err) { Logger.log('ntfy failed: ' + err); }
  }
}

// ---------------------------------------------------------------------------
// TRIAGE EXPIRY — optional daily call into mhud's inbox-expire cron
// ---------------------------------------------------------------------------
/**
 * Rolls stale Triage cards into Digest server-side (mhud owns the rule —
 * see /api/cron/inbox-expire). Skipped silently when KANBAN_CRON_SECRET is
 * unset, so this script works with zero config beyond the required
 * properties. Installed at hour 6 by setup().
 */
function expireTriage() {
  const c = cfg_();
  if (!c.KANBAN_CRON_SECRET) return;

  const base = c.KANBAN_MCP_URL.replace(/\/api\/mcp\/?$/, '');
  const res = UrlFetchApp.fetch(base + '/api/cron/inbox-expire', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + c.KANBAN_CRON_SECRET },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    Logger.log('inbox-expire cron failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
    return;
  }
  Logger.log('inbox-expire cron: ' + res.getContentText());
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function threadMeta_(thread) {
  const c = cfg_();
  const last = thread.getMessages().slice(-1)[0];
  return {
    thread: thread,
    id: thread.getId(),
    from: last.getFrom(),
    subject: thread.getFirstMessageSubject() || '(no subject)',
    date: last.getDate().toISOString(),
    snippet: (last.getPlainBody() || '').slice(0, 200),
    body: (last.getPlainBody() || '').slice(0, c.BODY_CHARS),
    permalink: thread.getPermalink(),
    bucket: null, summary: '', deadline: null, action: '',
  };
}

function claude_(c, model, system, userContent, maxTokens) {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': c.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: model,
      max_tokens: maxTokens,
      system: system,
      messages: [{ role: 'user', content: userContent }],
    }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 300) throw new Error('anthropic ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function senderOf_(thread) {
  try { return thread.getMessages().slice(-1)[0].getFrom().replace(/<.*>/, '').trim(); }
  catch (_) { return '?'; }
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
