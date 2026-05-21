import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  submitClaudeBuild,
  pollClaudeJobStatus,
  listClaudeProjects,
} from '../../src/lib/card-execution/mcp-client'

// ---------------------------------------------------------------------------
// Helpers — build the SSE envelope the real ClaudeMCP server emits:
// event: message\ndata: <json>\n\n
// ---------------------------------------------------------------------------

function sseEnvelope(inner: unknown): string {
  return `event: message\ndata: ${JSON.stringify(inner)}\n\n`
}

/** Wraps an inner result payload in the full JSON-RPC + content envelope. */
function mcpResult(innerJson: unknown): string {
  return sseEnvelope({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(innerJson) }],
    },
  })
}

/** Wraps a JSON-RPC error in the SSE envelope. */
function mcpError(message: string): string {
  return sseEnvelope({
    jsonrpc: '2.0',
    id: 1,
    error: { message },
  })
}

function makeFetchOk(body: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => body,
  } as unknown as Response)
}

function makeFetchError(status: number): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => `Internal Server Error`,
  } as unknown as Response)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mcp-client (card-execution)', () => {
  beforeEach(() => {
    process.env.CLAUDEMCP_URL = 'http://127.0.0.1:3101/mcp'
  })

  afterEach(() => {
    delete process.env.CLAUDEMCP_URL
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // submitClaudeBuild
  // -------------------------------------------------------------------------

  describe('submitClaudeBuild', () => {
    it('happy path: returns jobId and state from a valid SSE response', async () => {
      global.fetch = makeFetchOk(
        mcpResult({ jobId: 'abc', state: 'queued' })
      )

      const result = await submitClaudeBuild({
        project: 'kanban',
        spec: 'Add a /health endpoint.',
        branch: 'agent/card-12345678',
      })

      expect(result.jobId).toBe('abc')
      expect(result.state).toBe('queued')
    })

    it('throws when the response body has no jobId', async () => {
      global.fetch = makeFetchOk(
        // inner payload intentionally omits jobId
        mcpResult({ state: 'queued' })
      )

      await expect(
        submitClaudeBuild({ project: 'kanban', spec: 'spec', branch: 'agent/card-00000000' })
      ).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // pollClaudeJobStatus
  // -------------------------------------------------------------------------

  describe('pollClaudeJobStatus', () => {
    it('happy path (done): returns state, output, exitCode from a valid SSE response', async () => {
      const payload = {
        jobId: 'abc',
        state: 'done',
        output: 'FINAL COMMIT: deadbeef\nAll tests passed.',
        exitCode: 0,
        sessionId: 'sess-abc',
        branch: 'agent/card-12345678',
        commitSha: 'deadbeef',
      }
      global.fetch = makeFetchOk(mcpResult(payload))

      const result = await pollClaudeJobStatus('abc')

      expect(result.state).toBe('done')
      expect(result.output).toBe('FINAL COMMIT: deadbeef\nAll tests passed.')
      expect(result.exitCode).toBe(0)
      expect(result.sessionId).toBe('sess-abc')
      expect(result.branch).toBe('agent/card-12345678')
      expect(result.commitSha).toBe('deadbeef')
    })

    it('happy path (running): returns state with no terminal fields', async () => {
      global.fetch = makeFetchOk(
        mcpResult({ jobId: 'abc', state: 'running' })
      )

      const result = await pollClaudeJobStatus('abc')

      expect(result.state).toBe('running')
      expect(result.output).toBeUndefined()
      expect(result.exitCode).toBeUndefined()
    })

    it('happy path (failed): returns state and errorDetail', async () => {
      global.fetch = makeFetchOk(
        mcpResult({
          jobId: 'abc',
          state: 'failed',
          errorDetail: 'Build step exited with code 1',
          exitCode: 1,
        })
      )

      const result = await pollClaudeJobStatus('abc')

      expect(result.state).toBe('failed')
      expect(result.errorDetail).toBe('Build step exited with code 1')
      expect(result.exitCode).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // listClaudeProjects
  // -------------------------------------------------------------------------

  describe('listClaudeProjects', () => {
    it('happy path: returns the name array from projects registry', async () => {
      global.fetch = makeFetchOk(
        mcpResult({
          projects: [
            { name: 'spoonworks', defaultBranch: 'main' },
            { name: 'dash', defaultBranch: 'main' },
            { name: 'darksignal', defaultBranch: 'main' },
            { name: 'kanban', defaultBranch: 'main' },
          ],
        })
      )

      const result = await listClaudeProjects()

      expect(result).toEqual(['spoonworks', 'dash', 'darksignal', 'kanban'])
    })

    it('returns an empty array when the registry has no projects', async () => {
      global.fetch = makeFetchOk(mcpResult({ projects: [] }))

      const result = await listClaudeProjects()

      expect(result).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Shared error paths — each function must surface these consistently
  // -------------------------------------------------------------------------

  describe('HTTP non-2xx response', () => {
    it('submitClaudeBuild throws with the status code when server returns 500', async () => {
      global.fetch = makeFetchError(500)

      await expect(
        submitClaudeBuild({ project: 'kanban', spec: 'spec', branch: 'agent/card-00000000' })
      ).rejects.toThrow('500')
    })

    it('pollClaudeJobStatus throws with the status code when server returns 500', async () => {
      global.fetch = makeFetchError(500)

      await expect(pollClaudeJobStatus('abc')).rejects.toThrow('500')
    })

    it('listClaudeProjects throws with the status code when server returns 500', async () => {
      global.fetch = makeFetchError(500)

      await expect(listClaudeProjects()).rejects.toThrow('500')
    })

  })

  describe('malformed body (no event:/data: lines)', () => {
    const malformed = 'not sse at all — just garbage text'

    it('submitClaudeBuild throws with a descriptive message', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => malformed,
      } as unknown as Response)

      await expect(
        submitClaudeBuild({ project: 'kanban', spec: 'spec', branch: 'agent/card-00000000' })
      ).rejects.toThrow(/malformed|data:|parse/i)
    })

    it('pollClaudeJobStatus throws with a descriptive message', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => malformed,
      } as unknown as Response)

      await expect(pollClaudeJobStatus('abc')).rejects.toThrow(/malformed|data:|parse/i)
    })

    it('listClaudeProjects throws with a descriptive message', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => malformed,
      } as unknown as Response)

      await expect(listClaudeProjects()).rejects.toThrow(/malformed|data:|parse/i)
    })
  })

  describe('JSON-RPC error envelope', () => {
    it('submitClaudeBuild throws with the error message from the envelope', async () => {
      global.fetch = makeFetchOk(mcpError('recursion_limit_exceeded'))

      await expect(
        submitClaudeBuild({ project: 'kanban', spec: 'spec', branch: 'agent/card-00000000' })
      ).rejects.toThrow('recursion_limit_exceeded')
    })

    it('pollClaudeJobStatus throws with the error message from the envelope', async () => {
      global.fetch = makeFetchOk(mcpError('job not found'))

      await expect(pollClaudeJobStatus('missing-job')).rejects.toThrow('job not found')
    })

    it('listClaudeProjects throws with the error message from the envelope', async () => {
      global.fetch = makeFetchOk(mcpError('internal error'))

      await expect(listClaudeProjects()).rejects.toThrow('internal error')
    })
  })

  // -------------------------------------------------------------------------
  // CLAUDEMCP_URL unset
  // -------------------------------------------------------------------------

  describe('CLAUDEMCP_URL env unset', () => {
    beforeEach(() => {
      delete process.env.CLAUDEMCP_URL
    })

    it('submitClaudeBuild throws a clear message when CLAUDEMCP_URL is unset', async () => {
      await expect(
        submitClaudeBuild({ project: 'kanban', spec: 'spec', branch: 'agent/card-00000000' })
      ).rejects.toThrow(/CLAUDEMCP_URL/i)
    })

    it('pollClaudeJobStatus throws a clear message when CLAUDEMCP_URL is unset', async () => {
      await expect(pollClaudeJobStatus('abc')).rejects.toThrow(/CLAUDEMCP_URL/i)
    })

    it('listClaudeProjects throws a clear message when CLAUDEMCP_URL is unset', async () => {
      await expect(listClaudeProjects()).rejects.toThrow(/CLAUDEMCP_URL/i)
    })
  })
})
