// The Google Doc handoff (spec §4.11): the draft's Markdown becomes a Doc in
// the user's own Drive. Scope and auth failures propagate as the Google error
// classes so the route can offer the scope-upgrade link.

import { createDocFromMarkdown } from '@/lib/google/docs-write'

export async function handoffGoogleDoc(args: {
  userId: string
  title: string
  markdown: string
  folderId?: string
}): Promise<{ id: string; url: string }> {
  const doc = await createDocFromMarkdown(args.userId, {
    title: args.title,
    markdown: args.markdown,
    folderId: args.folderId,
  })
  return { id: doc.id, url: doc.webViewLink }
}
