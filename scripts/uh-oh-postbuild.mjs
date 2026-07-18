#!/usr/bin/env node
// uh-oh source map upload + cleanup. Runs automatically after every
// production build (wired as the `postbuild` npm lifecycle script, which npm
// invokes right after `npm run build` with no extra step required in the
// documented deploy sequence); also exposed directly as
// `npm run upload-sourcemaps` for a manual re-upload without rebuilding.
//
// Safety guarantee: a browser (static/**/*.js.map) source map that `next
// build` may have produced never survives past this script running, whether
// uh-oh is unconfigured (the vendored uploader below no-ops without ever
// touching the filesystem) or the upload partially fails (the vendored
// uploader deliberately refuses to delete on partial failure). `next start`
// serves .next/static as-is, so nothing here may ever end up public. This is
// what makes it safe for next.config.js to gate `productionBrowserSourceMaps`
// / `experimental.serverSourceMaps` on the uh-oh envs being present at build
// time, rather than relying on every deploy path remembering a manual step.
//
// Never fails the build: an uh-oh outage or misconfiguration must not block
// a deploy. Failures are logged, never propagated - this always exits 0.

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function findJsMaps(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...findJsMaps(full))
    else if (e.isFile() && e.name.endsWith('.js.map')) out.push(full)
  }
  return out
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
// Must match instrumentation.ts's RELEASE (`${pkg.version}+0`) - the uh-oh
// server can only symbolicate a crash's release against maps uploaded under
// the exact same release string.
const release = `${pkg.version}+0`

console.log(`[uh-oh] uploading source maps for release ${release}`)
const result = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'uh-oh-upload-sourcemaps.mjs'),
    '--dir',
    '.next',
    '--release',
    release,
    '--delete-browser-maps',
  ],
  { cwd: repoRoot, stdio: 'inherit' }
)
if (result.status !== 0) {
  console.error(`[uh-oh] source map upload exited ${result.status} (non-fatal; see output above)`)
}

// Unconditional safety sweep: regardless of the outcome above, no browser
// .js.map file may survive under .next/static.
const staticDir = join(repoRoot, '.next', 'static')
const leftover = findJsMaps(staticDir)
if (leftover.length > 0) {
  console.log(`[uh-oh] sweeping ${leftover.length} leftover browser source map file(s)`)
  for (const f of leftover) {
    try {
      unlinkSync(f)
    } catch (e) {
      console.error(`[uh-oh] could not delete ${f}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

process.exit(0)
