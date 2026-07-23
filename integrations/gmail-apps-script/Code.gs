/**
 * INBOX ZERO-TOUCH — Gmail triage → Claude → KanbanMCP
 * =====================================================
 * Runs entirely inside Google Apps Script. No app password, no server.
 *
 * Loop (every 30 min):
 *   1. Pull unprocessed inbox threads
 *   2. Hard rules first (2FA, DocuSign, VIP senders → URGENT passthrough)
 *   3. Claude classifies the rest: URGENT / ACTIONABLE / NEEDS_REPLY / FYI / NOISE
 *   4. URGENT + ACTIONABLE + NEEDS_REPLY → cards on your KanbanMCP board
 *      URGENT also fires the nudge webhook (your kanban UI) + optional ntfy push
 *   5. FYI + NOISE → labeled, archived, rolled into one daily digest/audit card
 *
 * Web app (doPost) actions, called from your kanban UI:
 *   draft : voice-note text + threadId → Claude writes reply → Gmail draft
 *   send  : draftId → sends the approved draft
 *   ack   : threadId → clears the urgent flag
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

    // KanbanMCP — JSON-RPC tools/call against your /api/mcp endpoint.
    // >>> MAP FIELDS in kanbanCreateCard_() to your actual create_card schema. <<<
    KANBAN_MCP_URL: req('KANBAN_MCP_URL'),          // e.g. https://kanban.yourhost.com/api/mcp
    KANBAN_API_KEY: req('KANBAN_API_KEY'),
    KANBAN_BOARD_ID: req('KANBAN_BOARD_ID'),
    COL_URGENT: req('COL_URGENT'),                  // column IDs on the board
    COL_TRIAGE: req('COL_TRIAGE'),
    COL_DIGEST: req('COL_DIGEST'),

    // Nudge surfaces
    NUDGE_WEBHOOK_URL: p.getProperty('NUDGE_WEBHOOK_URL') || '',  // kanban UI banner
    NUDGE_SECRET: p.getProperty('NUDGE_SECRET') || '',
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

function dispatch_(m, c) {
  switch (m.bucket) {
    case 'URGENT': {
      m.thread.addLabel(label_(LABELS.urgent));
      const card = kanbanCreateCard_(c, c.COL_URGENT, '🔴 ' + m.summary, cardBody_(m), 'urgent');
      fireNudge_(c, m, card);
      break; // stays in inbox on purpose
    }
    case 'ACTIONABLE':
      m.thread.addLabel(label_(LABELS.actionable));
      kanbanCreateCard_(c, c.COL_TRIAGE, m.summary, cardBody_(m), 'normal');
      m.thread.moveToArchive();
      break;
    case 'NEEDS_REPLY':
      m.thread.addLabel(label_(LABELS.needsReply));
      kanbanCreateCard_(c, c.COL_TRIAGE, '✉️ ' + m.summary, cardBody_(m) +
        '\n\n**Reply flow:** voice note on this card → agent drafts → you approve.', 'normal');
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
// KANBAN ADAPTER — the ONE place that knows your card schema
// ---------------------------------------------------------------------------
/**
 * Calls your MCP endpoint via JSON-RPC tools/call.
 * >>> Adjust `arguments` to match your actual create_card input schema
 *     (field names below are a best guess at boardId/columnId/title/description). <<<
 */
function kanbanCreateCard_(c, columnId, title, description, priority) {
  const payload = {
    jsonrpc: '2.0',
    id: Utilities.getUuid(),
    method: 'tools/call',
    params: {
      name: 'create_card',
      arguments: {
        boardId: c.KANBAN_BOARD_ID,
        columnId: columnId,
        title: title.slice(0, 200),
        description: description,
        priority: priority,
      },
    },
  };
  const res = UrlFetchApp.fetch(c.KANBAN_MCP_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + c.KANBAN_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('kanban ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
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
// NUDGE — banner in your kanban UI, optional phone push
// ---------------------------------------------------------------------------
function fireNudge_(c, m, card) {
  const nudge = {
    secret: c.NUDGE_SECRET,
    type: 'urgent_email',
    threadId: m.id,
    from: m.from,
    summary: m.summary,
    permalink: m.permalink,
    cardId: (card && card.result && card.result.cardId) || null,
    at: new Date().toISOString(),
  };
  if (c.NUDGE_WEBHOOK_URL) {
    try {
      UrlFetchApp.fetch(c.NUDGE_WEBHOOK_URL, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(nudge), muteHttpExceptions: true,
      });
    } catch (err) { Logger.log('nudge webhook failed: ' + err); }
  }
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
