/**
 * Unit tests for path safety + resolveProjectPath (M3 Task 2 — TDD)
 *
 * The module under test does NOT exist yet. These tests will fail to import
 * until @coder implements deliverables.ts. That is the correct TDD state.
 *
 * Functions under test:
 *   assertSafeDeliverablePath(p: string): void   // throws on unsafe
 *   resolveProjectPath(projectName: string): Promise<string | null>
 *   __setProjectsJsonReaderForTests(fn: (() => Promise<string>) | null): void
 *   resetDeliverablesCacheForTests(): void
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  assertSafeDeliverablePath,
  resolveProjectPath,
  __setProjectsJsonReaderForTests,
  resetDeliverablesCacheForTests,
} from '../../src/lib/card-execution/deliverables'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECTS_JSON_TWO_ENTRIES = JSON.stringify({
  spoonworks: { path: '/root/spoonworks' },
  dash: { path: '/root/dash' },
})

// ---------------------------------------------------------------------------
// assertSafeDeliverablePath
// ---------------------------------------------------------------------------

describe('assertSafeDeliverablePath', () => {
  it('accepts /deliverables/plan.md (canonical safe path)', () => {
    expect(() => assertSafeDeliverablePath('/deliverables/plan.md')).not.toThrow()
  })

  it('accepts /deliverables/sub/dir/nested.html (nested subdirectories under /deliverables/ are fine)', () => {
    expect(() =>
      assertSafeDeliverablePath('/deliverables/sub/dir/nested.html'),
    ).not.toThrow()
  })

  it('rejects /etc/passwd — does not start with /deliverables/', () => {
    expect(() => assertSafeDeliverablePath('/etc/passwd')).toThrow(/\/etc\/passwd/)
  })

  it('rejects /deliverables/../etc/passwd — direct parent escape via ..', () => {
    expect(() => assertSafeDeliverablePath('/deliverables/../etc/passwd')).toThrow()
  })

  it('rejects /deliverables/sub/../../etc — parent escape via nested subdirectory', () => {
    expect(() => assertSafeDeliverablePath('/deliverables/sub/../../etc')).toThrow()
  })

  it('rejects ../etc/passwd — relative path with parent traversal', () => {
    expect(() => assertSafeDeliverablePath('../etc/passwd')).toThrow()
  })

  it('rejects deliverables/plan.md — relative path missing leading slash', () => {
    expect(() => assertSafeDeliverablePath('deliverables/plan.md')).toThrow()
  })

  it('rejects empty string', () => {
    expect(() => assertSafeDeliverablePath('')).toThrow()
  })

  it('rejects path containing a null byte', () => {
    expect(() => assertSafeDeliverablePath('/deliverables/x\0.md')).toThrow()
  })

  it('rejects /deliverables//double-slash when posix-normalized path escapes /deliverables/', () => {
    // path.posix.normalize('/deliverables//double-slash') → '/deliverables/double-slash'
    // That stays inside /deliverables/, so this variant is actually safe — the
    // important invariant is that the NORMALIZED path must start with /deliverables/.
    // A path like '/deliverables//../etc' normalizes to '/etc' which must be rejected.
    expect(() =>
      assertSafeDeliverablePath('/deliverables//../etc'),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// resolveProjectPath
// ---------------------------------------------------------------------------

describe('resolveProjectPath', () => {
  beforeEach(() => {
    resetDeliverablesCacheForTests()
    vi.useFakeTimers()
  })

  afterEach(() => {
    __setProjectsJsonReaderForTests(null)
    vi.useRealTimers()
  })

  it('returns the path field for a known project name', async () => {
    __setProjectsJsonReaderForTests(async () => PROJECTS_JSON_TWO_ENTRIES)

    const result = await resolveProjectPath('spoonworks')

    expect(result).toBe('/root/spoonworks')
  })

  it('returns null for an unknown project name', async () => {
    __setProjectsJsonReaderForTests(async () => PROJECTS_JSON_TWO_ENTRIES)

    const result = await resolveProjectPath('nonexistent-project')

    expect(result).toBeNull()
  })

  it('second call within 60s uses cached read — reader is called only once', async () => {
    const spy = vi.fn<() => Promise<string>>().mockResolvedValue(PROJECTS_JSON_TWO_ENTRIES)
    __setProjectsJsonReaderForTests(spy)

    await resolveProjectPath('spoonworks')
    vi.advanceTimersByTime(59_000)
    await resolveProjectPath('dash')

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('after 61s the next call re-reads projects.json', async () => {
    const spy = vi.fn<() => Promise<string>>().mockResolvedValue(PROJECTS_JSON_TWO_ENTRIES)
    __setProjectsJsonReaderForTests(spy)

    await resolveProjectPath('spoonworks')
    expect(spy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(61_000)

    await resolveProjectPath('spoonworks')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('resetDeliverablesCacheForTests forces a re-read without advancing time', async () => {
    const spy = vi.fn<() => Promise<string>>().mockResolvedValue(PROJECTS_JSON_TWO_ENTRIES)
    __setProjectsJsonReaderForTests(spy)

    await resolveProjectPath('spoonworks')
    expect(spy).toHaveBeenCalledTimes(1)

    resetDeliverablesCacheForTests()

    await resolveProjectPath('spoonworks')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('propagates reader errors without swallowing them', async () => {
    const ioError = new Error('ENOENT: no such file or directory')
    __setProjectsJsonReaderForTests(async () => {
      throw ioError
    })

    await expect(resolveProjectPath('spoonworks')).rejects.toThrow(
      'ENOENT: no such file or directory',
    )
  })
})
