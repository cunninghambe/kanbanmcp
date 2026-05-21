function getMcpUrl(): string {
  const url = process.env.CLAUDEMCP_URL?.trim()
  if (!url) throw new Error('CLAUDEMCP_URL is not configured')
  return url
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
  if (!match) throw new Error(`ClaudeMCP malformed response — no data: line found: ${raw.slice(0, 200)}`)
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

export async function submitClaudeBuild(args: {
  project: string
  spec: string
  branch: string
  baseBranch?: string
  runTests?: boolean
  timeoutMs?: number
}): Promise<{ jobId: string; state: string }> {
  const url = getMcpUrl()
  const result = await postClaudeMCP(url, 'claude_build', {
    project: args.project,
    spec: args.spec,
    branch: args.branch,
    ...(args.baseBranch !== undefined && { baseBranch: args.baseBranch }),
    ...(args.runTests !== undefined && { runTests: args.runTests }),
    ...(args.timeoutMs !== undefined && { timeoutMs: args.timeoutMs }),
  })
  if (typeof result.jobId !== 'string' || !result.jobId) {
    throw new Error(`ClaudeMCP claude_build did not return jobId: ${JSON.stringify(result).slice(0, 200)}`)
  }
  return { jobId: result.jobId, state: String(result.state ?? '') }
}

export async function pollClaudeJobStatus(jobId: string): Promise<{
  state: string
  output?: string
  errorDetail?: string
  exitCode?: number
  sessionId?: string
  branch?: string
  commitSha?: string
}> {
  const url = getMcpUrl()
  const result = await postClaudeMCP(url, 'claude_job_status', { jobId })
  return {
    state: String(result.state ?? 'unknown'),
    ...(typeof result.output === 'string' && { output: result.output }),
    ...(typeof result.errorDetail === 'string' && { errorDetail: result.errorDetail }),
    ...(typeof result.exitCode === 'number' && { exitCode: result.exitCode }),
    ...(typeof result.sessionId === 'string' && { sessionId: result.sessionId }),
    ...(typeof result.branch === 'string' && { branch: result.branch }),
    ...(typeof result.commitSha === 'string' && { commitSha: result.commitSha }),
  }
}

export async function listClaudeProjects(): Promise<string[]> {
  const url = getMcpUrl()
  const result = await postClaudeMCP(url, 'claude_list_projects', {})
  const projects = result.projects
  if (!Array.isArray(projects)) return []
  return projects
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => String(p.name))
    .filter(Boolean)
}
