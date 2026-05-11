import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'

export type StorageDriver = {
  /** Persist bytes and return the canonical storage key. */
  put(key: string, bytes: Buffer, contentType: string): Promise<{ key: string }>
  /** Read the bytes back as a Node.js Readable stream. */
  getStream(key: string): Promise<Readable>
  /** Delete the underlying object. Idempotent — missing object is not an error. */
  delete(key: string): Promise<void>
}

/** Rejects keys containing path-traversal characters. */
function assertSafeKey(key: string): void {
  if (key.includes('/') || key.includes('\\') || key.includes('..') || key.includes('\0')) {
    throw new Error('Invalid storage key')
  }
}

function makeLocalDriver(baseDir: string): StorageDriver {
  const resolvedBase = path.resolve(baseDir)

  return {
    async put(key, bytes) {
      assertSafeKey(key)
      await fsp.mkdir(resolvedBase, { recursive: true })
      const dest = path.join(resolvedBase, key)
      await fsp.writeFile(dest, bytes, { mode: 0o640 })
      return { key }
    },

    async getStream(key) {
      assertSafeKey(key)
      return fs.createReadStream(path.join(resolvedBase, key))
    },

    async delete(key) {
      assertSafeKey(key)
      await fsp.unlink(path.join(resolvedBase, key)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
      })
    },
  }
}

function makeS3Driver(): StorageDriver {
  // Use an indirect require so webpack does not statically bundle the missing
  // module. The package is not installed in M1; this path throws at runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = process.env.STORAGE_DRIVER // keep reference to prevent dead-code elimination
  void mod
  // Dynamic require — not statically analysed by webpack.
  // eslint-disable-next-line no-new-func
  const tryRequire = new Function('m', 'return require(m)')
  try {
    tryRequire('@aws-sdk/client-s3')
  } catch {
    throw new Error('S3 driver requires @aws-sdk/client-s3 (not installed in M1)')
  }
  throw new Error('S3 driver requires @aws-sdk/client-s3 (not installed in M1)')
}

/** Returns the configured storage driver. Reads STORAGE_DRIVER and STORAGE_DIR env vars. */
export function getStorageDriver(): StorageDriver {
  const driver = process.env.STORAGE_DRIVER ?? 'local'
  if (driver === 's3') return makeS3Driver()
  return makeLocalDriver(process.env.STORAGE_DIR ?? './uploads')
}
