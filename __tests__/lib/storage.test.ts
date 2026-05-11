import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { getStorageDriver } from '../../src/lib/storage'

const tmpDir = path.join(os.tmpdir(), 'kanban-storage-test-' + process.pid)

function makeDriver() {
  process.env.STORAGE_DRIVER = 'local'
  process.env.STORAGE_DIR = tmpDir
  return getStorageDriver()
}

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('LocalStorageDriver', () => {
  it('round-trips bytes', async () => {
    const driver = makeDriver()
    const data = Buffer.from('hello world')
    await driver.put('testkey', data, 'text/plain')
    const stream = await driver.getStream('testkey')
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', resolve)
      stream.on('error', reject)
    })
    expect(Buffer.concat(chunks).toString()).toBe('hello world')
  })

  it('creates the directory on first use', async () => {
    const driver = makeDriver()
    await driver.put('newkey', Buffer.from('x'), 'text/plain')
    const stat = await fsp.stat(tmpDir)
    expect(stat.isDirectory()).toBe(true)
  })

  it('delete is idempotent — no error on ENOENT', async () => {
    const driver = makeDriver()
    await expect(driver.delete('nonexistent')).resolves.toBeUndefined()
  })

  it('delete removes the file', async () => {
    const driver = makeDriver()
    await driver.put('delkey', Buffer.from('bye'), 'text/plain')
    await driver.delete('delkey')
    await expect(fsp.access(path.join(tmpDir, 'delkey'))).rejects.toThrow()
  })

  it.each([
    ['key/with/slash'],
    ['key\\with\\backslash'],
    ['../traversal'],
    ['key\0null'],
  ])('rejects unsafe key: %s', async (key) => {
    const driver = makeDriver()
    await expect(driver.put(key, Buffer.from('x'), 'text/plain')).rejects.toThrow('Invalid storage key')
    await expect(driver.getStream(key)).rejects.toThrow('Invalid storage key')
    await expect(driver.delete(key)).rejects.toThrow('Invalid storage key')
  })
})
