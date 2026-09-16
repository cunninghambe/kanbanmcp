// The Slack handoff (spec §4.11). The text is escaped and scheme-allowlisted by
// `markdownToMrkdwn` before it leaves the app under the user's own identity, so
// model output can never notify a channel or smuggle a link target.

import { postMessage } from '@/lib/slack/client'
import { markdownToMrkdwn } from '@/lib/slack/format'

export async function handoffSlackPost(args: {
  userId: string
  channel: string
  markdown: string
  threadTs?: string
}): Promise<{ channel: string; ts: string; url: string | null }> {
  const posted = await postMessage(args.userId, {
    channel: args.channel,
    text: markdownToMrkdwn(args.markdown),
    threadTs: args.threadTs,
  })
  return { channel: posted.channel, ts: posted.ts, url: posted.permalink }
}
