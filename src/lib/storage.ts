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
  throw new Error('S3 driver not implemented in M1 (set STORAGE_DRIVER=local)')
}

/** Returns the configured storage driver. Reads STORAGE_DRIVER and STORAGE_DIR env vars. */
export function getStorageDriver(): StorageDriver {
  const driver = process.env.STORAGE_DRIVER ?? 'local'
  if (driver === 's3') return makeS3Driver()
  return makeLocalDriver(process.env.STORAGE_DIR ?? './uploads')
}
