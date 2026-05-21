import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises'
import type { ExecException } from 'node:child_process'

// ─── Module under test ────────────────────────────────────────────────────────
// Import after mocking child_process so the mock is in place at module load time.

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}))

import {
  readRegistry,
  writeRegistry,
  upsertProject,
  ensureProjectDirectory,
  reloadClaudeMcp,
  __setProjectsJsonPathForTests,
} from '../../src/lib/claude-mcp-registry'

import { exec as execRaw } from 'node:child_process'
import { promisify } from 'node:util'

const execMock = vi.mocked(execRaw)

let tmpDir: string
let registryPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-registry-test-'))
  registryPath = path.join(tmpDir, 'projects.json')
  __setProjectsJsonPathForTests(registryPath)
  execMock.mockReset()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ─── readRegistry / writeRegistry ─────────────────────────────────────────────

describe('readRegistry', () => {
  it('returns {} when the file does not exist', async () => {
    const reg = await readRegistry()
    expect(reg).toEqual({})
  })

  it('returns parsed registry when file exists', async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ spoonworks: { path: '/root/spoonworks', defaultBranch: 'main' } }),
      'utf-8'
    )
    const reg = await readRegistry()
    expect(reg.spoonworks).toEqual({ path: '/root/spoonworks', defaultBranch: 'main' })
  })
})

describe('writeRegistry', () => {
  it('writes the registry to disk and readRegistry round-trips it', async () => {
    const reg = { kanban: { path: '/opt/kanban', defaultBranch: 'main' } }
    await writeRegistry(reg)
    const read = await readRegistry()
    expect(read).toEqual(reg)
  })
})

// ─── upsertProject ────────────────────────────────────────────────────────────

describe('upsertProject', () => {
  it('adds a new project when the slug is absent', async () => {
    await upsertProject('my-board', '/opt/my-board')
    const reg = await readRegistry()
    expect(reg['my-board']).toEqual({ path: '/opt/my-board', defaultBranch: 'main' })
  })

  it('is idempotent: same slug + same path does not throw', async () => {
    await upsertProject('my-board', '/opt/my-board')
    await expect(upsertProject('my-board', '/opt/my-board')).resolves.toBeUndefined()
    const reg = await readRegistry()
    expect(Object.keys(reg)).toHaveLength(1)
  })

  it('throws when slug is already registered with a DIFFERENT path', async () => {
    await upsertProject('my-board', '/opt/my-board')
    await expect(upsertProject('my-board', '/opt/other-path')).rejects.toThrow(
      "already registered at '/opt/my-board'"
    )
  })

  it('uses the provided defaultBranch', async () => {
    await upsertProject('my-board', '/opt/my-board', 'develop')
    const reg = await readRegistry()
    expect(reg['my-board'].defaultBranch).toBe('develop')
  })
})

// ─── ensureProjectDirectory ───────────────────────────────────────────────────

describe('ensureProjectDirectory', () => {
  it('calls git init when .git does not exist', async () => {
    const projectDir = path.join(tmpDir, 'new-project')
    await mkdir(projectDir)

    // Simulate a real-ish exec: the first call (mkdir -p) is a no-op, then
    // git init creates .git, then add/commit.  We simulate by creating .git
    // on the git init call.
    type ExecCallback = (err: ExecException | null, stdout: string, stderr: string) => void
    execMock.mockImplementation(
      (cmd: string, _opts: unknown, cb?: ExecCallback) => {
        if (typeof _opts === 'function') {
          (_opts as ExecCallback)(null, '', '')
          return {} as ReturnType<typeof execRaw>
        }
        if (cmd.includes('git init')) {
          mkdir(path.join(projectDir, '.git')).then(() => cb?.(null, '', '')).catch(() => cb?.(null, '', ''))
        } else {
          cb?.(null, '', '')
        }
        return {} as ReturnType<typeof execRaw>
      }
    )

    await ensureProjectDirectory(projectDir, 'main')

    const gitInitCall = execMock.mock.calls.find(([cmd]) =>
      (cmd as string).includes('git init')
    )
    expect(gitInitCall).toBeDefined()
  })

  it('is a no-op when .git already exists', async () => {
    const projectDir = path.join(tmpDir, 'existing-project')
    await mkdir(projectDir)
    await mkdir(path.join(projectDir, '.git'))

    await ensureProjectDirectory(projectDir, 'main')

    expect(execMock).not.toHaveBeenCalled()
  })
})

// ─── reloadClaudeMcp ──────────────────────────────────────────────────────────

describe('reloadClaudeMcp', () => {
  it('shells out to pm2 sendSignal SIGHUP claude-mcp', async () => {
    type ExecCallback = (err: ExecException | null, stdout: string, stderr: string) => void
    execMock.mockImplementation(
      (_cmd: string, _opts: unknown, cb?: ExecCallback) => {
        if (typeof _opts === 'function') (_opts as ExecCallback)(null, '', '')
        else cb?.(null, '', '')
        return {} as ReturnType<typeof execRaw>
      }
    )

    await reloadClaudeMcp()

    const calls = execMock.mock.calls
    const sighupCall = calls.find(([cmd]) =>
      (cmd as string).includes('pm2 sendSignal SIGHUP claude-mcp')
    )
    expect(sighupCall).toBeDefined()
  })
})

// Prevent TS from complaining about unused promisify import (used conceptually).
void promisify
