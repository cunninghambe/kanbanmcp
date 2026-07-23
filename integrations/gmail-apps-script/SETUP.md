# Inbox Zero-Touch — Setup

Two pieces: the Apps Script (Code.gs, runs in your Google account) and a small
nudge integration you drop into kanbanmcp (Next.js).

## 1. Apps Script

1. script.new → paste Code.gs into the editor.
2. Project Settings → Script Properties, add:

| Property | Value |
|---|---|
| ANTHROPIC_API_KEY | your key |
| KANBAN_MCP_URL | https://your-kanban-host/api/mcp |
| KANBAN_API_KEY | agent API key from kanbanmcp |
| KANBAN_BOARD_ID | target board |
| COL_URGENT / COL_TRIAGE / COL_DIGEST | column IDs |
| WEBHOOK_TOKEN | random secret, shared with your kanban UI |
| NUDGE_WEBHOOK_URL | https://your-kanban-host/api/nudge (optional) |
| NUDGE_SECRET | random secret for the nudge route (optional) |
| NTFY_TOPIC | private ntfy.sh topic for phone push (optional) |
| VIP_SENDERS | e.g. `anthropic.com,greenhouse.io,lever.co,docusign` |
| VOICE_NOTES | style notes for reply drafts |

3. Run `setup()` once. Approve the OAuth scopes (Gmail + external requests).
   This creates the `ai/*` labels and installs the 30-min triage trigger and
   the 07:30 digest trigger.
4. Run `triage()` once manually and watch the execution log.
5. Deploy → New deployment → **Web app**, execute as *Me*, access
   *Anyone*. Copy the /exec URL. Auth is the WEBHOOK_TOKEN in the JSON body,
   which is why it must be long and random.

**Adapter note:** `kanbanCreateCard_()` guesses your `create_card` argument
names (boardId, columnId, title, description, priority). Check them against
your MCP tool schema. It is the only function that knows the card format.

## 2. Reply loop from a card

Your card UI calls the web app URL:

```js
// 1. Voice note transcribed (browser SpeechRecognition or keyboard dictation)
await fetch(EXEC_URL, { method: 'POST', body: JSON.stringify({
  token: WEBHOOK_TOKEN, action: 'draft',
  threadId,              // parsed from the `gmail:<id>` line in the card body
  instructions: voiceNoteText,
  replyAll: false,
})});
// → { draftId, preview, to }  → render preview on the card with Approve

// 2. Approve
await fetch(EXEC_URL, { method: 'POST', body: JSON.stringify({
  token: WEBHOOK_TOKEN, action: 'send', draftId,
})});
```

One caveat: an Apps Script web app deployed with "Anyone" access is public
internet with token auth. Fine for this threat model, but keep the token out
of client-side code if you can; proxy the call through a kanbanmcp API route
so the token stays server-side.

## 3. Urgent nudge banner in kanbanmcp

Apps Script POSTs urgent events to `/api/nudge`. The banner polls it and
sits above the board until you ack. In-memory store is fine for a single
long-running instance; if you deploy serverless, back it with a tiny Prisma
table instead.

### app/api/nudge/route.ts

```ts
import { NextRequest, NextResponse } from 'next/server';

type Nudge = { threadId: string; from: string; summary: string;
               permalink: string; cardId: string | null; at: string };

const g = globalThis as unknown as { nudges?: Map<string, Nudge> };
g.nudges ??= new Map();

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (body.secret !== process.env.NUDGE_SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  g.nudges!.set(body.threadId, body);
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ nudges: [...g.nudges!.values()] });
}

export async function DELETE(req: NextRequest) {
  const { threadId } = await req.json();
  g.nudges!.delete(threadId);
  return NextResponse.json({ ok: true });
}
```

### components/UrgentNudgeBanner.tsx

Drop into your board layout. Inherits your Tailwind setup; restyle to match
your tokens.

```tsx
'use client';
import { useEffect, useState, useCallback } from 'react';

type Nudge = { threadId: string; from: string; summary: string;
               permalink: string; cardId: string | null };

export default function UrgentNudgeBanner() {
  const [nudges, setNudges] = useState<Nudge[]>([]);

  const poll = useCallback(async () => {
    try {
      const r = await fetch('/api/nudge');
      setNudges((await r.json()).nudges ?? []);
    } catch { /* board still works if polling fails */ }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [poll]);

  const ack = async (threadId: string) => {
    setNudges((n) => n.filter((x) => x.threadId !== threadId));
    await fetch('/api/nudge', { method: 'DELETE',
      body: JSON.stringify({ threadId }) });
    // also clears the ai/urgent Gmail label, via your server-side proxy:
    await fetch('/api/inbox-agent', { method: 'POST',
      body: JSON.stringify({ action: 'ack', threadId }) });
  };

  if (!nudges.length) return null;
  return (
    <div role="alert" aria-live="assertive"
         className="sticky top-0 z-50 border-b border-red-300 bg-red-50">
      {nudges.map((n) => (
        <div key={n.threadId}
             className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2 text-sm">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-600" />
          <span className="min-w-0 truncate">
            <strong>{n.from.replace(/<.*>/, '').trim()}</strong>: {n.summary}
          </span>
          <span className="ml-auto flex shrink-0 gap-2">
            {n.cardId && (
              <a href={`/card/${n.cardId}`}
                 className="rounded bg-red-600 px-2 py-1 font-medium text-white">
                Open card
              </a>
            )}
            <a href={n.permalink} target="_blank" rel="noreferrer"
               className="rounded border border-red-300 px-2 py-1">
              Gmail
            </a>
            <button onClick={() => ack(n.threadId)}
                    className="rounded px-2 py-1 text-red-700 underline">
              Ack
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
```

`/api/inbox-agent` is the thin server-side proxy from section 2 that forwards
to the Apps Script /exec URL with the token attached. Three actions pass
through it: draft, send, ack.

## 4. First month protocol

- Read the 07:30 digest card daily. It lists everything archived as FYI or
  noise. Misfiles get fixed by adding senders to VIP_SENDERS or sharpening
  the classifier prompt, not by reopening Gmail.
- Classifier outage fails safe: unclassifiable mail becomes triage cards,
  never silently archived.
- Untouched triage cards should auto-expire into the digest after ~5 days.
  That rule belongs in kanbanmcp, not the script; without it you will
  rebuild your inbox as a kanban column.
