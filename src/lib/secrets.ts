import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

function getKey(): Buffer {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY
  if (!hex) {
    throw new Error(
      'SETTINGS_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32'
    )
  }
  const key = Buffer.from(hex, 'hex')
  if (key.length !== 32) {
    throw new Error('SETTINGS_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
  }
  return key
}

/** Returns base64(iv[12] || tag[16] || ciphertext). */
export function encryptSecret(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

/** Inverse of encryptSecret. Throws if the ciphertext has been tampered with. */
export function decryptSecret(ciphertext: string): string {
  const key = getKey()
  const buf = Buffer.from(ciphertext, 'base64')
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Invalid ciphertext: too short')
  }
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const encrypted = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted) + decipher.final('utf8')
}

/** Returns "sk-ant-…XXXX" showing only the last 6 characters. */
export function maskApiKey(key: string): string {
  if (key.length <= 6) return '…' + key
  return 'sk-ant-…' + key.slice(-6)
}
