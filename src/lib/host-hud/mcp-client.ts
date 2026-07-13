// ClaudeMCP client for the Host Meeting HUD. Uses the Q&A-oriented `claude_run`
// tool (prompt → answer) rather than the build-oriented `claude_build` used by
// card-execution. The external ClaudeMCP agent holds the actual read access to
// boards / Drive / email / Slack via its own tool configuration; this module
// only submits a target-aware prompt and polls for the cited answer.

function getMcpUrl(): string {
  const url = process.env.CLAUDEMCP_URL?.trim()
  if (!url) throw new Error('CLAUDEMCP_URL is not configured')
  return url
}

function getDispatchProject(): string {
  // The read-only ClaudeMCP project the HUD dispatches against. Falls back to
  // CLAUDEMCP_PROJECT so a single-project deployment works out of the box.
  const project = process.env.HUD_DISPATCH_PROJECT?.trim() || process.env.CLAUDEMCP_PROJECT?.trim()
  if (!project) throw new Error('HUD_DISPATCH_PROJECT (or CLAUDEMCP_PROJECT) is not configured')
  return project
}

async function postClaudeMCP(
  url: string,
  tool: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`ClaudeMCP HTTP ${response.status}: ${body.slice(0, 300)}`)
  }
  const raw = await response.text()
  const match = raw.match(/^data: (.+)$/m)
  if (!match) throw new Error(`ClaudeMCP malformed response — no data: line: ${raw.slice(0, 200)}`)
  const outer = JSON.parse(match[1]) as {
    error?: { message?: string }
    result?: { content?: Array<{ text?: string }> }
  }
  if (outer.error) {
    throw new Error(`ClaudeMCP error: ${outer.error.message ?? JSON.stringify(outer.error)}`)
  }
  const inner = outer.result?.content?.[0]?.text
  if (typeof inner !== 'string') {
    throw new Error(`ClaudeMCP missing content[0].text: ${raw.slice(0, 200)}`)
  }
  return JSON.parse(inner) as Record<string, unknown>
}

export async function submitDispatch(args: {
  prompt: string
  timeoutMs?: number
}): Promise<{ jobId: string; state: string }> {
  const url = getMcpUrl()
  const result = await postClaudeMCP(url, 'claude_run', {
    project: getDispatchProject(),
    prompt: args.prompt,
    ...(args.timeoutMs !== undefined && { timeoutMs: args.timeoutMs }),
  })
  if (typeof result.jobId !== 'string' || !result.jobId) {
    throw new Error(`ClaudeMCP claude_run did not return jobId: ${JSON.stringify(result).slice(0, 200)}`)
  }
  return { jobId: result.jobId, state: String(result.state ?? 'queued') }
}

export async function pollDispatchStatus(jobId: string): Promise<{
  state: string
  output?: string
  errorDetail?: string
}> {
  const url = getMcpUrl()
  const result = await postClaudeMCP(url, 'claude_job_status', { jobId })
  return {
    state: String(result.state ?? 'unknown'),
    ...(typeof result.output === 'string' && { output: result.output }),
    ...(typeof result.errorDetail === 'string' && { errorDetail: result.errorDetail }),
  }
}

/**
 * Requests cancellation of a running/queued ClaudeMCP job (SIGTERM→SIGKILL on the
 * server side). Best-effort: the caller must not depend on it succeeding — the
 * local dispatch is already terminal by the time this runs.
 */
export async function cancelDispatch(jobId: string): Promise<void> {
  const url = getMcpUrl()
  await postClaudeMCP(url, 'claude_job_cancel', { jobId })
}

export type DispatchMcpClient = {
  submitDispatch: typeof submitDispatch
  pollDispatchStatus: typeof pollDispatchStatus
  cancelDispatch: typeof cancelDispatch
}
